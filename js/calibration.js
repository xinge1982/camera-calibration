export function computeHomography(worldPoints, imagePoints) {
  const matrix = [];
  const rhs = [];
  for (let i = 0; i < 4; i += 1) {
    const { x: X, y: Y } = worldPoints[i];
    const { x: u, y: v } = imagePoints[i];
    matrix.push([X, Y, 1, 0, 0, 0, -u * X, -u * Y]); rhs.push(u);
    matrix.push([0, 0, 0, X, Y, 1, -v * X, -v * Y]); rhs.push(v);
  }
  const h = solveLinear(matrix, rhs);
  return [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
}

export function calibrateIntrinsics(views) {
  if (views.length < 3) throw new Error('至少需要 3 张已完成照片');
  const homographies = views.map(view => computeHomography(worldCorners(view.width, view.distance), view.points));
  const constraints = [];
  homographies.forEach(H => {
    const h1 = [H[0][0], H[1][0], H[2][0]];
    const h2 = [H[0][1], H[1][1], H[2][1]];
    constraints.push(normalizeConstraint(vRow(h1, h2)));
    const v11 = vRow(h1, h1); const v22 = vRow(h2, h2);
    constraints.push(normalizeConstraint(v11.map((value, index) => value - v22[index])));
  });
  const normal = multiplyTranspose(constraints);
  let b = smallestEigenvector(normal);
  if (b[0] < 0) b = b.map(value => -value);
  const [B11, B12, B22, B13, B23, B33] = b;
  const denominator = B11 * B22 - B12 * B12;
  if (Math.abs(denominator) < 1e-18 || B11 <= 0) throw new Error('照片视角差异不足，无法稳定求解内参');
  const cy = (B12 * B13 - B11 * B23) / denominator;
  const lambda = B33 - (B13 * B13 + cy * (B12 * B13 - B11 * B23)) / B11;
  if (lambda <= 0) throw new Error('标定点几何关系无效，请检查四点顺序和位置');
  const fx = Math.sqrt(lambda / B11);
  const fy = Math.sqrt(lambda * B11 / denominator);
  const skew = -B12 * fx * fx * fy / lambda;
  const cx = skew * cy / fy - B13 * fx * fx / lambda;
  const values = [fx, fy, cx, cy, skew];
  if (!values.every(Number.isFinite) || fx < 10 || fy < 10) throw new Error('内参结果不稳定，请增加不同视角照片');
  const K = [[fx, skew, cx], [0, fy, cy], [0, 0, 1]];
  const rms = calculateRms(homographies, views, K);
  return { fx, fy, cx, cy, skew, rms, views: views.length, matrix: K, distortion: { k1: 0, k2: 0, p1: 0, p2: 0, k3: 0 } };
}

function worldCorners(width, distance) {
  return [{ x: 0, y: distance }, { x: width, y: distance }, { x: 0, y: 0 }, { x: width, y: 0 }];
}

function vRow(a, b) {
  return [a[0] * b[0], a[0] * b[1] + a[1] * b[0], a[1] * b[1], a[2] * b[0] + a[0] * b[2], a[2] * b[1] + a[1] * b[2], a[2] * b[2]];
}

function normalizeConstraint(row) {
  const length = Math.hypot(...row);
  return row.map(value => value / length);
}

function solveLinear(input, values) {
  const A = input.map((row, i) => [...row, values[i]]);
  const n = A.length;
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) if (Math.abs(A[row][column]) > Math.abs(A[pivot][column])) pivot = row;
    if (Math.abs(A[pivot][column]) < 1e-12) throw new Error('四个标定点不能共线');
    [A[column], A[pivot]] = [A[pivot], A[column]];
    const divisor = A[column][column];
    for (let j = column; j <= n; j += 1) A[column][j] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const factor = A[row][column];
      for (let j = column; j <= n; j += 1) A[row][j] -= factor * A[column][j];
    }
  }
  return A.map((row, i) => row[n]);
}

function multiplyTranspose(rows) {
  const result = Array.from({ length: 6 }, () => Array(6).fill(0));
  rows.forEach(row => { for (let i = 0; i < 6; i += 1) for (let j = 0; j < 6; j += 1) result[i][j] += row[i] * row[j]; });
  return result;
}

function smallestEigenvector(input) {
  const shifted = input.map((row, i) => row.map((value, j) => value + (i === j ? 1e-10 : 0)));
  let vector = [1, .7, .5, .3, .2, .1];
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const next = solveLinear(shifted, vector);
    const length = Math.hypot(...next);
    vector = next.map(value => value / length);
  }
  return vector;
}

function calculateRms(homographies, views, K) {
  const inverseK = inverse3(K); let error = 0; let count = 0;
  homographies.forEach((H, index) => {
    const h1 = column(H, 0); const h2 = column(H, 1); const h3 = column(H, 2);
    let r1 = multiplyVector(inverseK, h1); let r2 = multiplyVector(inverseK, h2); let t = multiplyVector(inverseK, h3);
    const scale = 2 / (norm(r1) + norm(r2)); r1 = scaleVector(r1, scale); r2 = scaleVector(r2, scale); t = scaleVector(t, scale);
    r1 = normalize(r1); r2 = normalize(subtract(r2, scaleVector(r1, dot(r1, r2))));
    const predicted = multiply3(K, [[r1[0], r2[0], t[0]], [r1[1], r2[1], t[1]], [r1[2], r2[2], t[2]]]);
    worldCorners(views[index].width, views[index].distance).forEach((point, i) => {
      const projected = project(predicted, point); const observed = views[index].points[i];
      error += (projected.x - observed.x) ** 2 + (projected.y - observed.y) ** 2; count += 2;
    });
  });
  return Math.sqrt(error / count);
}

const column = (matrix, i) => matrix.map(row => row[i]);
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const norm = vector => Math.hypot(...vector);
const normalize = vector => scaleVector(vector, 1 / norm(vector));
const scaleVector = (vector, scale) => vector.map(value => value * scale);
const subtract = (a, b) => a.map((value, i) => value - b[i]);
const multiplyVector = (matrix, vector) => matrix.map(row => dot(row, vector));
const multiply3 = (a, b) => a.map(row => [0, 1, 2].map(columnIndex => row.reduce((sum, value, i) => sum + value * b[i][columnIndex], 0)));
const project = (H, point) => { const p = multiplyVector(H, [point.x, point.y, 1]); return { x: p[0] / p[2], y: p[1] / p[2] }; };
function inverse3(m) {
  const d = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  return [[(m[1][1]*m[2][2]-m[1][2]*m[2][1])/d,(m[0][2]*m[2][1]-m[0][1]*m[2][2])/d,(m[0][1]*m[1][2]-m[0][2]*m[1][1])/d],[(m[1][2]*m[2][0]-m[1][0]*m[2][2])/d,(m[0][0]*m[2][2]-m[0][2]*m[2][0])/d,(m[0][2]*m[1][0]-m[0][0]*m[1][2])/d],[(m[1][0]*m[2][1]-m[1][1]*m[2][0])/d,(m[0][1]*m[2][0]-m[0][0]*m[2][1])/d,(m[0][0]*m[1][1]-m[0][1]*m[1][0])/d]];
}
