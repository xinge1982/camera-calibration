import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrateIntrinsics, computeHomography } from '../js/calibration.js';

const K = [[1200, 0, 960], [0, 1180, 540], [0, 0, 1]];
const width = 7.2;
const distance = 25;
const world = [[0, distance, 0], [width, distance, 0], [0, 0, 0], [width, 0, 0]];

const multiply = (a, b) => a.map(row => b[0].map((_, j) => row.reduce((sum, value, i) => sum + value * b[i][j], 0)));
const rx = a => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
const ry = a => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
const rz = a => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];

function makeView(ax, ay, az, t) {
  const R = multiply(rz(az), multiply(ry(ay), rx(ax)));
  const points = world.map(([X, Y]) => {
    const point = [R[0][0] * X + R[0][1] * Y + t[0], R[1][0] * X + R[1][1] * Y + t[1], R[2][0] * X + R[2][1] * Y + t[2]];
    return { x: K[0][0] * point[0] / point[2] + K[0][2], y: K[1][1] * point[1] / point[2] + K[1][2] };
  });
  return { points, width, distance, imageWidth: 1920, imageHeight: 1080 };
}

const diverseViews = [
  makeView(-0.45, 0.10, 0.02, [-3, -8, 30]),
  makeView(-0.30, -0.16, 0.08, [-4, -7, 28]),
  makeView(-0.58, 0.20, -0.10, [-2, -6, 35]),
  makeView(-0.38, -0.25, 0.13, [-3, -9, 32])
];

test('normalized DLT maps the four plane points back to their pixels', () => {
  const plane = [{ x: 0, y: distance }, { x: width, y: distance }, { x: 0, y: 0 }, { x: width, y: 0 }];
  const H = computeHomography(plane, diverseViews[0].points);
  plane.forEach((point, index) => {
    const p = [H[0][0] * point.x + H[0][1] * point.y + H[0][2], H[1][0] * point.x + H[1][1] * point.y + H[1][2], H[2][0] * point.x + H[2][1] * point.y + H[2][2]];
    assert.ok(Math.abs(p[0] / p[2] - diverseViews[0].points[index].x) < 1e-3);
    assert.ok(Math.abs(p[1] / p[2] - diverseViews[0].points[index].y) < 1e-3);
  });
});

test('recovers known intrinsics from diverse ideal plane orientations', () => {
  const result = calibrateIntrinsics(diverseViews);
  assert.ok(Math.abs(result.fx - 1200) < 1e-2);
  assert.ok(Math.abs(result.fy - 1180) < 1e-2);
  assert.ok(Math.abs(result.cx - 960) < 1e-2);
  assert.ok(Math.abs(result.cy - 540) < 1e-2);
  assert.ok(result.rms < 1e-3);
});

test('rejects views that only translate with the same plane orientation', () => {
  const sameOrientation = [
    makeView(-0.45, 0.10, 0.02, [-3, -8, 30]),
    makeView(-0.45, 0.10, 0.02, [-4, -7, 28]),
    makeView(-0.45, 0.10, 0.02, [-2, -6, 35]),
    makeView(-0.45, 0.10, 0.02, [-3, -9, 32])
  ];
  assert.throws(() => calibrateIntrinsics(sameOrientation), /视角几乎重复/);
});

test('rejects mixed image resolutions', () => {
  const mixed = diverseViews.map(view => ({ ...view }));
  mixed[2] = { ...mixed[2], imageWidth: 1280 };
  assert.throws(() => calibrateIntrinsics(mixed), /分辨率不同/);
});
