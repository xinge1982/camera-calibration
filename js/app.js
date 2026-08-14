import { calibrateIntrinsics, inspectView } from './calibration.js';

const STORAGE_KEY = 'road-calibration-v3';
const defaultPoints = (width, height) => [{ x: width * .43, y: height * .38 }, { x: width * .57, y: height * .38 }, { x: width * .22, y: height * .88 }, { x: width * .78, y: height * .88 }];
const state = { photos: [], activeId: null, history: [], activePoint: null, result: null };
const $ = id => document.getElementById(id);
const elements = { list: $('photoList'), empty: $('emptyState'), viewer: $('viewerCard'), image: $('calibrationImage'), overlay: $('overlay'), polygon: $('roadPolygon'), controls: [...document.querySelectorAll('.control')] };

async function loadManifest() {
  try {
    const response = await fetch(`photos/manifest.json?t=${Date.now()}`);
    if (!response.ok) throw new Error();
    const manifest = await response.json();
    loadPhotos(manifest.map(item => ({ id: item.src, name: item.name, src: item.src })));
  } catch (_) { renderPhotoList(); }
}

function loadPhotos(incoming) {
  const saved = readSavedState();
  state.photos.forEach(photo => { if (photo.objectUrl) URL.revokeObjectURL(photo.src); });
  state.photos = incoming.map(photo => ({ ...photo, width: 0, height: 0, points: null, roadWidth: 7.2, distance: 25, completed: false, ...(saved.photos?.[photo.id] || {}) }));
  state.activeId = state.photos[0]?.id || null;
  state.result = saved.result || null;
  if (state.result?.perViewErrors) state.photos.filter(photo => photo.completed).forEach((photo, index) => { photo.calibrationError = state.result.perViewErrors[index]; });
  renderPhotoList(); updateProgress();
  if (state.activeId) activatePhoto(state.activeId);
}

function activatePhoto(id) {
  saveCurrentState(); state.activeId = id; state.history = [];
  const photo = activePhoto(); if (!photo) return;
  elements.image.onload = () => {
    const sizeChanged = photo.width > 0 && (photo.width !== elements.image.naturalWidth || photo.height !== elements.image.naturalHeight);
    photo.width = elements.image.naturalWidth; photo.height = elements.image.naturalHeight;
    if (sizeChanged) { photo.points = null; photo.completed = false; clearCalibrationResult(); notify('图片尺寸已变化，旧标注已清除', true); }
    if (!photo.points || photo.points.length !== 4) photo.points = defaultPoints(photo.width, photo.height);
    elements.overlay.setAttribute('viewBox', `0 0 ${photo.width} ${photo.height}`);
    layoutImage(); renderActive(); if (state.result) renderResult(); persist();
  };
  elements.image.src = photo.src; elements.viewer.classList.add('ready');
  $('activePhotoName').textContent = photo.name; renderPhotoList();
}

function layoutImage() {
  const photo = activePhoto(); if (!photo?.width) return;
  const rect = elements.viewer.getBoundingClientRect(); const scale = Math.min(rect.width / photo.width, rect.height / photo.height);
  const width = photo.width * scale; const height = photo.height * scale; const left = (rect.width - width) / 2; const top = (rect.height - height) / 2;
  [elements.image, elements.overlay].forEach(element => Object.assign(element.style, { width: `${width}px`, height: `${height}px`, left: `${left}px`, top: `${top}px` }));
}

function renderActive() {
  const photo = activePhoto(); if (!photo?.points) return;
  const polygonOrder = [photo.points[0], photo.points[1], photo.points[3], photo.points[2]];
  elements.polygon.setAttribute('points', polygonOrder.map(point => `${point.x},${point.y}`).join(' '));
  setLine('leftBoundary', photo.points[0], photo.points[2]); setLine('rightBoundary', photo.points[1], photo.points[3]);
  elements.controls.forEach((control, index) => { const p = photo.points[index]; const circle = control.querySelector('circle'); const text = control.querySelector('text'); circle.setAttribute('cx', p.x); circle.setAttribute('cy', p.y); text.setAttribute('x', p.x); text.setAttribute('y', p.y + 4); $('point' + index).textContent = `x ${Math.round(p.x)}  ·  y ${Math.round(p.y)}`; });
  $('imageDimensions').textContent = `${photo.width} × ${photo.height}`; $('roadWidthInput').value = photo.roadWidth; $('distanceInput').value = photo.distance; $('roadWidthOutput').textContent = `${photo.roadWidth} m`; $('distanceOutput').textContent = `${photo.distance} m`;
  $('activeStatus').textContent = photo.completed ? '已完成' : '调整中'; $('activeStatus').className = `status ${photo.completed ? 'done' : 'waiting'}`; $('completeButton').disabled = false;
  updateQuality(photo); updateProgress();
}

function renderPhotoList() {
  elements.empty.hidden = state.photos.length > 0; elements.list.hidden = !state.photos.length; $('photoCount').textContent = state.photos.length;
  elements.list.replaceChildren(...state.photos.map((photo, index) => {
    const button = document.createElement('button'); button.className = `photo-item ${photo.id === state.activeId ? 'active' : ''} ${photo.completed ? 'done' : ''}`; button.type = 'button'; button.setAttribute('role', 'listitem');
    const thumb = document.createElement('img'); thumb.className = 'photo-thumb'; thumb.src = photo.src; thumb.alt = '';
    const copy = document.createElement('span'); copy.className = 'photo-copy'; const name = document.createElement('strong'); name.textContent = photo.name; const meta = document.createElement('small'); meta.textContent = Number.isFinite(photo.calibrationError) ? `RMS ${photo.calibrationError.toFixed(2)} px` : photo.completed ? '标定完成' : `照片 ${index + 1}`; copy.append(name, meta);
    const check = document.createElement('span'); check.className = 'photo-check'; check.textContent = '✓'; button.append(thumb, copy, check); button.addEventListener('click', () => activatePhoto(photo.id)); return button;
  }));
}

function updateQuality(photo) {
  const inspection = inspectView({ ...photo, imageWidth: photo.width, imageHeight: photo.height });
  $('qualityScore').textContent = inspection.score; $('qualityBar').style.width = `${inspection.score}%`; $('qualityLabel').textContent = inspection.valid ? inspection.score >= 88 ? '几何良好' : '可以完成' : '需要调整';
  $('qualityHint').textContent = inspection.hint;
  $('completeButton').disabled = !inspection.valid;
}

function updateProgress() {
  const completed = state.photos.filter(photo => photo.completed).length; const total = state.photos.length; const percent = total ? completed / total * 100 : 0;
  $('progressText').textContent = `${completed} / ${total}`; $('progressBar').style.width = `${percent}%`; $('sessionSummary').textContent = total ? `${completed} / ${total} 张已标定` : '等待照片';
  $('calculateButton').disabled = completed < 3; $('viewCount').textContent = completed; $('exportButton').disabled = !state.result;
}

function completePhoto() { const photo = activePhoto(); if (!photo) return; photo.completed = true; clearCalibrationResult(); persist(); renderActive(); renderPhotoList(); notify(`${photo.name} 标定已保存`); }
function resetPhoto() { const photo = activePhoto(); if (!photo) return; state.history.push(clonePoints(photo.points)); photo.points = defaultPoints(photo.width, photo.height); photo.completed = false; clearCalibrationResult(); renderActive(); renderPhotoList(); persist(); }
function undo() { const photo = activePhoto(); if (!photo || !state.history.length) return notify('没有可撤销的操作'); photo.points = state.history.pop(); photo.completed = false; clearCalibrationResult(); renderActive(); renderPhotoList(); persist(); }

function calculate() {
  try {
    const completed = state.photos.filter(photo => photo.completed);
    const views = completed.map(photo => ({ name: photo.name, points: photo.points, width: photo.roadWidth, distance: photo.distance, imageWidth: photo.width, imageHeight: photo.height }));
    state.result = calibrateIntrinsics(views);
    completed.forEach((photo, index) => { photo.calibrationError = state.result.perViewErrors[index]; });
    renderResult(); renderPhotoList(); updateProgress(); persist(); notify('统一相机内参计算完成');
  } catch (error) { notify(error.message, true); }
}

function renderResult() {
  const result = state.result; if (!result) return;
  const constrained = result.calibrationMode === 'constrained-forward-view';
  $('mFx').textContent = result.fx.toFixed(2); $('mFy').textContent = result.fy.toFixed(2); $('mCx').textContent = result.cx.toFixed(2); $('mCy').textContent = result.cy.toFixed(2); $('mSkew').textContent = result.skew.toFixed(3); $('rmsValue').textContent = `${result.rms.toFixed(3)} px`; $('viewCount').textContent = result.views; $('resultBadge').textContent = constrained ? '约束解' : '完整解'; $('resultBadge').className = 'status done';
  $('diversityValue').textContent = constrained ? '固定车载约束' : '完整多视图';
  $('resultHelp').textContent = constrained ? '当前照片倾角重复，因此 fx=fy，只估计一个共同焦距；cx、cy固定为图像中心，skew固定为0。请把它视为有明确假设的约束结果。' : 'RMS 越小，所有照片对同一组内参的解释越一致。它不是绝对精度保证；请同时检查逐张 RMS 和下面的警告。';
  $('warningList').replaceChildren(...result.warnings.map(message => { const item = document.createElement('li'); item.textContent = message; return item; }));
}

function exportResult() {
  if (!state.result) return;
  const calibrated = state.photos.filter(photo => photo.completed);
  const constrainedAssumptions = state.result.calibrationMode === 'constrained-forward-view' ? ['cx=imageWidth/2', 'cy=imageHeight/2', 'skew=0', 'fx=fy'] : [];
  const payload = { schemaVersion: 3, model: 'pinhole', calibrationMode: state.result.calibrationMode, assumptions: ['同一相机、焦距、分辨率和裁剪方式', '四点对应同一个真实道路矩形', '镜头畸变暂未估计', ...constrainedAssumptions], imageSize: commonImageSize(), cameraMatrix: state.result.matrix, fx: state.result.fx, fy: state.result.fy, cx: state.result.cx, cy: state.result.cy, skew: state.result.skew, distortion: state.result.distortion, rmsReprojectionError: state.result.rms, diversityRatio: state.result.diversityRatio, warnings: state.result.warnings, calibratedViews: calibrated.map((photo, index) => ({ name: photo.name, imageSize: { width: photo.width, height: photo.height }, roadWidthM: photo.roadWidth, referenceDistanceM: photo.distance, points: photo.points, rmsReprojectionError: state.result.perViewErrors[index] })), generatedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'camera-intrinsics.json'; link.click(); URL.revokeObjectURL(link.href); notify('相机内参 JSON 已导出');
}

function handleFolder(files) {
  const images = [...files].filter(file => file.type.startsWith('image/')).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  loadPhotos(images.map(file => ({ id: `${file.webkitRelativePath}:${file.size}:${file.lastModified}`, name: file.name, src: URL.createObjectURL(file), objectUrl: true })));
}

elements.controls.forEach((control, index) => {
  control.addEventListener('pointerdown', event => { const photo = activePhoto(); if (!photo) return; state.history.push(clonePoints(photo.points)); if (state.history.length > 30) state.history.shift(); state.activePoint = index; control.classList.add('dragging'); control.setPointerCapture(event.pointerId); });
  control.addEventListener('pointermove', event => { if (state.activePoint !== index) return; const photo = activePhoto(); const rect = elements.overlay.getBoundingClientRect(); photo.points[index] = { x: clamp((event.clientX - rect.left) / rect.width * photo.width, 0, photo.width), y: clamp((event.clientY - rect.top) / rect.height * photo.height, 0, photo.height) }; photo.completed = false; clearCalibrationResult(); renderActive(); renderPhotoList(); });
  const release = event => { if (state.activePoint === index) { state.activePoint = null; control.classList.remove('dragging'); persist(); } try { control.releasePointerCapture(event.pointerId); } catch (_) {} };
  control.addEventListener('pointerup', release); control.addEventListener('pointercancel', release);
});

$('pickFolderButton').addEventListener('click', () => $('folderInput').click()); $('folderInput').addEventListener('change', event => handleFolder(event.target.files)); $('undoButton').addEventListener('click', undo); $('resetPhotoButton').addEventListener('click', resetPhoto); $('completeButton').addEventListener('click', completePhoto); $('calculateButton').addEventListener('click', calculate); $('exportButton').addEventListener('click', exportResult);
$('roadWidthInput').addEventListener('input', event => { const photo = activePhoto(); if (!photo) return; photo.roadWidth = Number(event.target.value); photo.completed = false; clearCalibrationResult(); renderActive(); renderPhotoList(); persist(); });
$('distanceInput').addEventListener('input', event => { const photo = activePhoto(); if (!photo) return; photo.distance = Number(event.target.value); photo.completed = false; clearCalibrationResult(); renderActive(); renderPhotoList(); persist(); });
$('resetAllButton').addEventListener('click', () => { if (!state.photos.length || !confirm('确定清除所有照片的标定结果吗？')) return; state.photos.forEach(photo => { photo.points = photo.width ? defaultPoints(photo.width, photo.height) : null; photo.completed = false; }); clearCalibrationResult(); localStorage.removeItem(STORAGE_KEY); if (activePhoto()) renderActive(); renderPhotoList(); updateProgress(); notify('全部标定结果已重置'); });
window.addEventListener('resize', layoutImage);

function activePhoto() { return state.photos.find(photo => photo.id === state.activeId); }
function setLine(id, a, b) { const line = $(id); line.setAttribute('x1', a.x); line.setAttribute('y1', a.y); line.setAttribute('x2', b.x); line.setAttribute('y2', b.y); }
function saveCurrentState() { persist(); }
function persist() { const photos = {}; state.photos.forEach(({ id, points, width, height, roadWidth, distance, completed }) => { photos[id] = { points, width, height, roadWidth, distance, completed }; }); localStorage.setItem(STORAGE_KEY, JSON.stringify({ photos, result: state.result })); }
function readSavedState() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (_) { return {}; } }
function commonImageSize() { const photo = state.photos.find(item => item.completed); return photo ? { width: photo.width, height: photo.height } : null; }
function clonePoints(points) { return points.map(point => ({ ...point })); }
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function clearCalibrationResult() { state.result = null; state.photos.forEach(photo => { delete photo.calibrationError; }); $('resultBadge').textContent = '待计算'; $('resultBadge').className = 'status waiting'; $('warningList').replaceChildren(); $('diversityValue').textContent = '—'; $('resultHelp').textContent = 'RMS 越小，所有照片对同一组内参的解释越一致。它不是绝对精度保证；请同时检查逐张 RMS 和下面的警告。'; }
let toastTimer; function notify(message, error = false) { const toast = $('toast'); toast.textContent = message; toast.style.background = error ? 'var(--danger)' : 'var(--lime)'; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2400); }

loadManifest();
