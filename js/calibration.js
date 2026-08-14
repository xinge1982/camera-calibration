export function computeHomography(worldPoints, imagePoints) {
  if (worldPoints.length !== imagePoints.length || worldPoints.length < 4) throw new Error('单应矩阵至少需要 4 组一一对应的点');
  const world = normalizePoints(worldPoints);
  const image = normalizePoints(imagePoints);
  const rows = [];
  for (let i = 0; i < world.points.length; i += 1) {
    const { x: X, y: Y } = world.points[i];
    const { x: u, y: v } = image.points[i];
    rows.push([-X, -Y, -1, 0, 0, 0, u * X, u * Y, u]);
    rows.push([0, 0, 0, -X, -Y, -1, v * X, v * Y, v]);
  }
  const eigensystem = symmetricEigen(multiplyTranspose(rows));
  const h = eigensystem.vectors.map(row => row[eigensystem.order[0]]);
  const normalizedH = [h.slice(0, 3), h.slice(3, 6), h.slice(6, 9)];
  const H = multiply3(inverse3(image.transform), multiply3(normalizedH, world.transform));
  const scale = Math.abs(H[2][2]) > 1e-12 ? H[2][2] : matrixNorm(H);
  return H.map(row => row.map(value => value / scale));
}

export function calibrateIntrinsics(views, options = {}) {
  if (views.length < 3) throw new Error('至少需要 3 张已完成照片，建议使用 5～10 张');
  validateViews(views);
  const homographies = views.map(view => computeHomography(worldCorners(view.width, view.distance), view.points));
  const mode = options.mode || 'constrained-forward-view';
  if (mode === 'constrained-forward-view') return calibrateConstrainedForwardViews(homographies, views, 0);
  if (mode !== 'full-multiview' && mode !== 'auto') throw new Error(`未知标定模式：${mode}`);
  const constraints = [];
  homographies.forEach(H => {
    const h1 = column(H, 0);
    const h2 = column(H, 1);
    constraints.push(normalizeConstraint(vRow(h1, h2)));
    const v11 = vRow(h1, h1);
    const v22 = vRow(h2, h2);
    constraints.push(normalizeConstraint(v11.map((value, index) => value - v22[index])));
  });
  const eigensystem = symmetricEigen(multiplyTranspose(constraints));
  const orderedValues = eigensystem.order.map(index => Math.max(0, eigensystem.values[index]));
  const largest = orderedValues.at(-1) || 1;
  const diversityRatio = (orderedValues[1] || 0) / largest;
  if (diversityRatio < 1e-9) return calibrateConstrainedForwardViews(homographies, views, diversityRatio);

  let b = eigensystem.vectors.map(row => row[eigensystem.order[0]]);
  if (b[0] < 0) b = b.map(value => -value);
  const [B11, B12, B22, B13, B23, B33] = b;
  const denominator = B11 * B22 - B12 * B12;
  if (Math.abs(denominator) < 1e-18 || B11 <= 0) throw new Error('无法形成有效内参：请检查四点对应关系，并增加不同道路倾角的照片');
  const cy = (B12 * B13 - B11 * B23) / denominator;
  const lambda = B33 - (B13 * B13 + cy * (B12 * B13 - B11 * B23)) / B11;
  if (lambda <= 0) throw new Error('标定点几何关系无效，请检查近端、远端四点是否对应同一个真实矩形');
  const fx = Math.sqrt(lambda / B11);
  const fy = Math.sqrt(lambda * B11 / denominator);
  const skew = -B12 * fx * fx * fy / lambda;
  const cx = skew * cy / fy - B13 * fx * fx / lambda;
  if (![fx, fy, cx, cy, skew].every(Number.isFinite) || fx < 10 || fy < 10) throw new Error('内参结果不稳定，请检查点位或增加视角差异');

  const K = [[fx, skew, cx], [0, fy, cy], [0, 0, 1]];
  const reprojection = calculateReprojection(homographies, views, K);
  const warnings = buildWarnings({ fx, fy, cx, cy, skew, rms: reprojection.rms, views, diversityRatio });
  return {
    fx, fy, cx, cy, skew,
    calibrationMode: 'full-multiview',
    rms: reprojection.rms,
    perViewErrors: reprojection.perViewErrors,
    views: views.length,
    matrix: K,
    diversityRatio,
    warnings,
    distortion: { k1: 0, k2: 0, p1: 0, p2: 0, k3: 0 }
  };
}

function calibrateConstrainedForwardViews(homographies, views, diversityRatio) {
  const { imageWidth, imageHeight } = views[0];
  const cx = imageWidth / 2;
  const cy = imageHeight / 2;
  const inverseFocalSquaredCandidates = [];

  homographies.forEach(H => {
    const h1 = column(H, 0);
    const h2 = column(H, 1);
    const x1 = h1[0] - cx * h1[2];
    const y1 = h1[1] - cy * h1[2];
    const x2 = h2[0] - cx * h2[2];
    const y2 = h2[1] - cy * h2[2];

    // With K = [[f,0,cx],[0,f,cy],[0,0,1]], rotation columns remain
    // orthogonal and equal-length. Each condition gives an estimate of 1/f².
    const orthogonalDenominator = x1 * x2 + y1 * y2;
    if (Math.abs(orthogonalDenominator) > 1e-15) {
      const value = -(h1[2] * h2[2]) / orthogonalDenominator;
      if (value > 0 && Number.isFinite(value)) inverseFocalSquaredCandidates.push(value);
    }

    const equalNormDenominator = x1 * x1 + y1 * y1 - x2 * x2 - y2 * y2;
    if (Math.abs(equalNormDenominator) > 1e-15) {
      const value = (h2[2] * h2[2] - h1[2] * h1[2]) / equalNormDenominator;
      if (value > 0 && Number.isFinite(value)) inverseFocalSquaredCandidates.push(value);
    }
  });

  if (!inverseFocalSquaredCandidates.length) {
    throw new Error('固定车载模式仍无法估计焦距：请检查道路矩形的真实长宽比例和四点顺序');
  }

  const inverseFocalSquared = median(inverseFocalSquaredCandidates);
  const focal = Math.sqrt(1 / inverseFocalSquared);
  const minimumFocal = Math.max(imageWidth, imageHeight) * 0.2;
  const maximumFocal = Math.max(imageWidth, imageHeight) * 10;
  if (!Number.isFinite(focal) || focal < minimumFocal || focal > maximumFocal) {
    throw new Error(`固定车载模式得到不合理焦距 ${focal.toFixed(1)} px；请检查道路矩形尺寸和点位`);
  }

  const fx = focal;
  const fy = focal;
  const skew = 0;
  const K = [[fx, 0, cx], [0, fy, cy], [0, 0, 1]];
  const reprojection = calculateReprojection(homographies, views, K);
  const warnings = [
    '已自动使用固定车载相机约束模式：因为所有照片的道路平面倾角近似相同，无法自由估计完整内参。',
    `主点已固定为图像中心 (${cx.toFixed(1)}, ${cy.toFixed(1)})，并固定 skew=0、fx=fy。`,
    '当前输出只有一个由已知道路矩形估计的共同焦距 f；它不是 cx、cy、fx、fy 的四参数独立测量。',
    '道路矩形的真实长宽比例或四点位置有误时，焦距会产生系统性偏差。',
    '当前模型未估计镜头畸变；导出的畸变参数为 0。'
  ];

  return {
    fx, fy, cx, cy, skew,
    calibrationMode: 'constrained-forward-view',
    rms: reprojection.rms,
    perViewErrors: reprojection.perViewErrors,
    views: views.length,
    matrix: K,
    diversityRatio,
    focalCandidateCount: inverseFocalSquaredCandidates.length,
    warnings,
    distortion: { k1: 0, k2: 0, p1: 0, p2: 0, k3: 0 }
  };
}

export function inspectView(view) {
  const [farLeft, farRight, nearLeft, nearRight] = view.points;
  const polygon = [farLeft, farRight, nearRight, nearLeft];
  const areaRatio = Math.abs(polygonArea(polygon)) / Math.max(1, view.imageWidth * view.imageHeight);
  const farWidth = distance(farLeft, farRight);
  const nearWidth = distance(nearLeft, nearRight);
  const orderValid = farLeft.x < farRight.x && nearLeft.x < nearRight.x;
  const depthOrderValid = (farLeft.y + farRight.y) / 2 < (nearLeft.y + nearRight.y) / 2;
  const convex = isConvex(polygon);
  const perspectiveValid = nearWidth > farWidth * 1.03;
  const valid = convex && areaRatio > 0.002;
  let score = 20 + Number(orderValid) * 20 + Number(depthOrderValid) * 20 + Number(convex) * 20 + Number(perspectiveValid) * 10;
  score += Math.min(10, areaRatio * 200);
  let hint = '几何关系可以参与计算。完成前请再确认：四点确实对应同一个真实道路矩形。';
  if (!orderValid) hint = '左右顺序可能标反：远端和近端都应先标左点，再标右点。';
  else if (!depthOrderValid) hint = '远近顺序可能标反：一般情况下，远端横边应位于近端横边的图像上方。';
  else if (!convex) hint = '四条边发生交叉。请按“远左、远右、近左、近右”重新检查四点。';
  else if (areaRatio <= 0.002) hint = '这个真实矩形在照片中太小，几像素的点击误差就会明显影响结果。建议换一张更近、更清楚的照片。';
  else if (!perspectiveValid) hint = '近端横边通常看起来比远端横边更宽。特殊坡度可以例外，但请先检查远近点是否标反。';
  return { valid, score: Math.round(Math.min(98, score)), hint, areaRatio, perspectiveValid };
}

function validateViews(views) {
  const first = views[0];
  views.forEach((view, index) => {
    if (view.imageWidth !== first.imageWidth || view.imageHeight !== first.imageHeight) throw new Error(`第 ${index + 1} 张照片分辨率不同；统一内参要求相同分辨率与裁剪方式`);
    if (!(view.width > 0) || !(view.distance > 0)) throw new Error(`第 ${index + 1} 张照片的道路尺寸无效`);
    const inspection = inspectView(view);
    if (!inspection.valid) throw new Error(`第 ${index + 1} 张照片几何无效：${inspection.hint}`);
  });
}

function worldCorners(width, distance) {
  return [{ x: 0, y: distance }, { x: width, y: distance }, { x: 0, y: 0 }, { x: width, y: 0 }];
}

function vRow(a, b) {
  return [a[0] * b[0], a[0] * b[1] + a[1] * b[0], a[1] * b[1], a[2] * b[0] + a[0] * b[2], a[2] * b[1] + a[1] * b[2], a[2] * b[2]];
}

function normalizeConstraint(row) {
  const length = Math.hypot(...row);
  if (length < 1e-15) throw new Error('当前视图不能提供有效平面约束');
  return row.map(value => value / length);
}

function normalizePoints(points) {
  const center = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
  center.x /= points.length;
  center.y /= points.length;
  const meanDistance = points.reduce((sum, point) => sum + Math.hypot(point.x - center.x, point.y - center.y), 0) / points.length;
  if (meanDistance < 1e-12) throw new Error('标定点不能重合');
  const scale = Math.SQRT2 / meanDistance;
  return {
    transform: [[scale, 0, -scale * center.x], [0, scale, -scale * center.y], [0, 0, 1]],
    points: points.map(point => ({ x: scale * (point.x - center.x), y: scale * (point.y - center.y) }))
  };
}

function multiplyTranspose(rows) {
  const size = rows[0].length;
  const result = Array.from({ length: size }, () => Array(size).fill(0));
  rows.forEach(row => {
    for (let i = 0; i < size; i += 1) for (let j = i; j < size; j += 1) {
      result[i][j] += row[i] * row[j];
      if (i !== j) result[j][i] = result[i][j];
    }
  });
  return result;
}

function symmetricEigen(input) {
  const size = input.length;
  const matrix = input.map(row => [...row]);
  const vectors = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => Number(i === j)));
  const tolerance = Math.max(1, matrixNorm(matrix)) * 1e-14;
  for (let iteration = 0; iteration < size * size * 80; iteration += 1) {
    let p = 0; let q = 1; let maximum = 0;
    for (let i = 0; i < size; i += 1) for (let j = i + 1; j < size; j += 1) if (Math.abs(matrix[i][j]) > maximum) {
      maximum = Math.abs(matrix[i][j]); p = i; q = j;
    }
    if (maximum < tolerance) break;
    const angle = 0.5 * Math.atan2(2 * matrix[p][q], matrix[q][q] - matrix[p][p]);
    const cosine = Math.cos(angle); const sine = Math.sin(angle);
    for (let k = 0; k < size; k += 1) {
      if (k === p || k === q) continue;
      const mkp = matrix[k][p]; const mkq = matrix[k][q];
      matrix[k][p] = matrix[p][k] = cosine * mkp - sine * mkq;
      matrix[k][q] = matrix[q][k] = sine * mkp + cosine * mkq;
    }
    const app = matrix[p][p]; const aqq = matrix[q][q]; const apq = matrix[p][q];
    matrix[p][p] = cosine * cosine * app - 2 * sine * cosine * apq + sine * sine * aqq;
    matrix[q][q] = sine * sine * app + 2 * sine * cosine * apq + cosine * cosine * aqq;
    matrix[p][q] = matrix[q][p] = 0;
    for (let k = 0; k < size; k += 1) {
      const vkp = vectors[k][p]; const vkq = vectors[k][q];
      vectors[k][p] = cosine * vkp - sine * vkq;
      vectors[k][q] = sine * vkp + cosine * vkq;
    }
  }
  const values = matrix.map((row, index) => row[index]);
  const order = values.map((_, index) => index).sort((a, b) => values[a] - values[b]);
  return { values, vectors, order };
}

function calculateReprojection(homographies, views, K) {
  const inverseK = inverse3(K);
  let totalSquaredError = 0; let totalCoordinates = 0;
  const perViewErrors = [];
  homographies.forEach((H, index) => {
    let r1 = multiplyVector(inverseK, column(H, 0));
    let r2 = multiplyVector(inverseK, column(H, 1));
    let t = multiplyVector(inverseK, column(H, 2));
    const scale = 2 / (norm(r1) + norm(r2));
    r1 = scaleVector(r1, scale); r2 = scaleVector(r2, scale); t = scaleVector(t, scale);
    r1 = normalize(r1);
    r2 = normalize(subtract(r2, scaleVector(r1, dot(r1, r2))));
    const projection = multiply3(K, [[r1[0], r2[0], t[0]], [r1[1], r2[1], t[1]], [r1[2], r2[2], t[2]]]);
    let viewSquaredError = 0;
    worldCorners(views[index].width, views[index].distance).forEach((point, pointIndex) => {
      const projected = project(projection, point); const observed = views[index].points[pointIndex];
      viewSquaredError += (projected.x - observed.x) ** 2 + (projected.y - observed.y) ** 2;
    });
    totalSquaredError += viewSquaredError; totalCoordinates += 8;
    perViewErrors.push(Math.sqrt(viewSquaredError / 8));
  });
  return { rms: Math.sqrt(totalSquaredError / totalCoordinates), perViewErrors };
}

function buildWarnings({ fx, fy, cx, cy, skew, rms, views, diversityRatio }) {
  const warnings = ['当前模型未估计镜头畸变；导出的畸变参数为 0。'];
  const { imageWidth, imageHeight } = views[0];
  if (views.length < 5) warnings.push('有效视图少于 5 张，结果对人工点位误差较敏感。');
  if (cx < 0 || cx > imageWidth || cy < 0 || cy > imageHeight) warnings.push('主点落在图像范围之外，通常说明对应点或视角存在问题。');
  if (Math.abs(skew) > 0.01 * Math.max(fx, fy)) warnings.push('skew 偏大；现代相机通常接近 0，请复核数据。');
  if (Math.max(fx, fy) / Math.min(fx, fy) > 1.2) warnings.push('fx 与 fy 差异超过 20%，请确认图片没有非等比例缩放。');
  if (rms > 3) warnings.push('RMS 超过 3 px，建议检查逐张误差并重新标注异常视图。');
  if (diversityRatio < 1e-6) warnings.push('视角多样性偏弱，建议增加不同坡度或相机俯仰角的照片。');
  return warnings;
}

function polygonArea(points) {
  return points.reduce((sum, point, index) => { const next = points[(index + 1) % points.length]; return sum + point.x * next.y - next.x * point.y; }, 0) / 2;
}

function isConvex(points) {
  let sign = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]; const b = points[(i + 1) % points.length]; const c = points[(i + 2) % points.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    if (!sign) sign = Math.sign(cross); else if (Math.sign(cross) !== sign) return false;
  }
  return sign !== 0;
}

const column = (matrix, i) => matrix.map(row => row[i]);
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const norm = vector => Math.hypot(...vector);
const normalize = vector => scaleVector(vector, 1 / norm(vector));
const scaleVector = (vector, scale) => vector.map(value => value * scale);
const subtract = (a, b) => a.map((value, i) => value - b[i]);
const multiplyVector = (matrix, vector) => matrix.map(row => dot(row, vector));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const matrixNorm = matrix => Math.hypot(...matrix.flat());
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const multiply3 = (a, b) => a.map(row => [0, 1, 2].map(columnIndex => row.reduce((sum, value, i) => sum + value * b[i][columnIndex], 0)));
const project = (H, point) => { const p = multiplyVector(H, [point.x, point.y, 1]); return { x: p[0] / p[2], y: p[1] / p[2] }; };

function inverse3(m) {
  const d = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (Math.abs(d) < 1e-18) throw new Error('矩阵不可逆，标定点可能接近共线');
  return [[(m[1][1] * m[2][2] - m[1][2] * m[2][1]) / d, (m[0][2] * m[2][1] - m[0][1] * m[2][2]) / d, (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / d], [(m[1][2] * m[2][0] - m[1][0] * m[2][2]) / d, (m[0][0] * m[2][2] - m[0][2] * m[2][0]) / d, (m[0][2] * m[1][0] - m[0][0] * m[1][2]) / d], [(m[1][0] * m[2][1] - m[1][1] * m[2][0]) / d, (m[0][1] * m[2][0] - m[0][0] * m[2][1]) / d, (m[0][0] * m[1][1] - m[0][1] * m[1][0]) / d]];
}
