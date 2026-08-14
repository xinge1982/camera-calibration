# Road Calibration UI

一个无前端框架依赖的多照片道路平面标定工具。用户逐张设置道路标定点，完成至少三张照片后，当前网页默认按照固定车载约束模式估计共同焦距并导出 JSON 结果。算法仍保留完整多视图模式供显式调用。

## 主要功能

1. 从 `photos/manifest.json` 自动读取照片列表，或直接选择本地照片文件夹。
2. 在照片上拖动同一个真实道路矩形的远端左/右、近端左/右四个角点，实时显示原始图像像素坐标。
3. 为每张照片独立保存四点、道路宽度、参考距离和完成状态。
4. 支持撤销、单张重置及全部重置。
5. 至少完成三张照片后，在固定车载约束下输出 `fx=fy=f`、图像中心 `cx/cy` 和 `skew=0`。
6. 检查分辨率、四边形有效性和视角退化，计算整体与逐张 RMS。
7. 导出包含假设、警告、点位和逐张误差的 `camera-intrinsics.json`。
8. 使用 `localStorage` 保存当前标定会话。

## 项目结构

```text
index.html                       页面结构和交互控件
css/styles.css                   三栏布局及视觉样式
js/app.js                        照片、状态、拖拽、持久化与导出
js/calibration.js                单应矩阵、内参及 RMS 算法
photos/                          本地照片目录
photos/manifest.json             浏览器照片清单
scripts/build-photo-manifest.mjs 扫描 photos 并生成清单
```

## 运行方法

1. 将 JPG、JPEG、PNG、WebP、BMP、GIF 或 SVG 图片复制到 `photos`。
2. 生成照片清单：`node scripts/build-photo-manifest.mjs`。
3. 启动静态服务器：`python3 -m http.server 8080`。
4. 访问 `http://localhost:8080`。

也可以点击页面中的“选择本地 photos 文件夹”。本地照片只会生成临时浏览器 URL，不会上传服务器。

## 标定点定义

每张照片的标定点数组顺序必须保持不变：

| 索引 | 名称 | 业务含义 |
| ---: | --- | --- |
| `0` | 远端左 FL | 左道路边界与远端真实截面的交点 |
| `1` | 远端右 FR | 右道路边界与远端真实截面的交点 |
| `2` | 近端左 NL | 左道路边界与近端真实截面的交点 |
| `3` | 近端右 NR | 右道路边界与近端真实截面的交点 |

四点必须对应现实中同一个已知长宽比的矩形。图像边缘不是现实世界截面，不能把“车道线与图像边缘的交点”直接当作远端角点。

点坐标采用原始照片像素坐标，而不是页面缩放后的显示坐标。默认位置由 `defaultPoints(width, height)` 生成：

```js
[
  { x: width * 0.43, y: height * 0.38 },
  { x: width * 0.57, y: height * 0.38 },
  { x: width * 0.22, y: height * 0.88 },
  { x: width * 0.78, y: height * 0.88 }
]
```

## 页面布局

页面针对电脑屏幕设计，采用三栏布局：

- 左侧：照片列表、文件夹选择和整体标定进度。
- 中间：当前照片、SVG 标定层、四点坐标和撤销/重置操作。
- 右侧：道路参考尺寸、几何质量、单张完成操作及统一内参结果。

当前 CSS 设置了 `min-width: 1180px`，尚未完整适配窄屏设备。

## 照片加载

### Manifest 模式

`loadManifest()` 在页面启动后请求 `photos/manifest.json`：

```json
[
  { "name": "road-01.jpg", "src": "photos/road-01.jpg" }
]
```

`scripts/build-photo-manifest.mjs` 扫描 `photos`，筛选支持的图片格式，按文件名排序并生成清单。

### 本地文件夹模式

页面通过带有 `webkitdirectory` 和 `multiple` 属性的文件输入框读取目录。`handleFolder(files)` 会筛选图片、排序，并使用 `URL.createObjectURL()` 创建临时访问地址。

## 状态结构

`js/app.js` 中的全局状态：

```js
const state = {
  photos: [],
  activeId: null,
  history: [],
  activePoint: null,
  result: null
};
```

- `photos`：全部照片及其标定数据。
- `activeId`：当前照片 ID。
- `history`：当前照片的撤销历史，最多保存 30 步。
- `activePoint`：正在拖动的点索引。
- `result`：最近一次统一内参结果。

单张照片数据大致如下：

```js
{
  id,
  name,
  src,
  width,
  height,
  points,
  roadWidth: 7.2,
  distance: 25,
  completed: false
}
```

## 照片切换和显示

`activatePhoto(id)` 负责保存当前状态、切换照片、读取原始尺寸、生成默认点、设置 SVG `viewBox`，然后调用 `layoutImage()` 和 `renderActive()`。

`layoutImage()` 使用与 `object-fit: contain` 相同的缩放逻辑，使 SVG 标定层与照片的实际显示区域重合。

## 标定点拖拽

每个 SVG 控制点监听 `pointerdown`、`pointermove`、`pointerup` 和 `pointercancel`。拖动时将页面坐标换算为原图像素坐标：

```js
x = (clientX - overlayLeft) / overlayWidth * imageWidth;
y = (clientY - overlayTop) / overlayHeight * imageHeight;
```

坐标会被限制在原图范围内。任何点位或道路尺寸变化都会将当前照片重新设为“未完成”，并使旧的统一内参失效。

## 单张几何质量

`inspectView(view)` 根据以下规则生成 20～98 的交互质量分数：

- 四点是否组成非自交凸四边形。
- 标定区域是否足够大。
- 左右点顺序和远近点顺序是否合理。
- 近端像素宽度是否大于远端像素宽度。

该分数只用于交互提示，不是重投影误差。凸性和最小面积是硬性检查；特殊坡度可能不满足常见透视方向，因此透视比例只警告、不直接否决。

## 统一内参计算

算法位于 `js/calibration.js`，入口为 `calibrateIntrinsics(views)`，至少需要三张已完成照片。

### 1. 道路平面坐标

道路参考平面由道路宽度 `width` 和参考距离 `distance` 定义，并与 TL、TR、BL、BR 一一对应：

```js
[
  { x: 0,     y: distance },
  { x: width, y: distance },
  { x: 0,     y: 0 },
  { x: width, y: 0 }
]
```

### 2. 单应矩阵

`computeHomography(worldPoints, imagePoints)` 先分别归一化世界点和图像点，再使用 normalized DLT 构造齐次方程，通过最小特征向量求解并反归一化：

```text
H = [ h11 h12 h13 ]
    [ h21 h22 h23 ]
    [ h31 h32  1  ]
```

### 3. 多视图约束

每张照片提供两条约束：

```text
h1ᵀ B h2 = 0
h1ᵀ B h1 - h2ᵀ B h2 = 0
```

其中 `B = K⁻ᵀK⁻¹`。所有照片的约束组合后，通过对称 Jacobi 特征分解求解 `B`。该完整多视图路径需要显式调用 `calibrateIntrinsics(views, { mode: 'full-multiview' })`。

### 4.1 固定车载约束模式

当前网页针对只有前向平移、道路平面倾角近似相同的数据，默认采用：

```text
cx = imageWidth / 2
cy = imageHeight / 2
skew = 0
fx = fy = f
```

每个单应矩阵仍可利用旋转矩阵两列“正交且等长”的性质提供 `1/f²` 候选值。程序取所有有效候选的中位数得到共同焦距 `f`。输出会标记 `calibrationMode: constrained-forward-view`，明确说明 `cx`、`cy`、`skew` 是固定假设而非独立估计值。

### 4.2 恢复完整内参

从 `B` 恢复 `fx`、`fy`、`cx`、`cy` 和 `skew`：

```text
K = [ fx  skew  cx ]
    [  0    fy  cy ]
    [  0     0   1 ]
```

### 5. RMS 重投影误差

程序根据单应矩阵和内参恢复每张照片的近似外参，将道路平面点重新投影到照片，计算整体和逐张像素 RMS。逐张结果显示在左侧照片列表，可用于定位异常标注。由于 RMS 使用的仍是参与拟合的四点，它是内部一致性指标，不等同于独立验证误差。

## 结果导出

`exportResult()` 输出 `camera-intrinsics.json`：

```json
{
  "model": "pinhole",
  "imageSize": { "width": 1920, "height": 1080 },
  "cameraMatrix": [],
  "fx": 0,
  "fy": 0,
  "cx": 0,
  "cy": 0,
  "skew": 0,
  "distortion": { "k1": 0, "k2": 0, "p1": 0, "p2": 0, "k3": 0 },
  "rmsReprojectionError": 0,
  "diversityRatio": 0,
  "warnings": [],
  "calibratedViews": [],
  "generatedAt": ""
}
```

## 本地持久化

标定会话保存到 `localStorage`，键名为 `road-calibration-v3`。内容包括每张照片的四点、图片尺寸、道路宽度、参考距离、完成状态及最近一次内参结果。重新载入相同照片 ID 时会恢复对应数据。由于 v3 修正了四点业务含义，它不会误用旧版的图像边缘标注。

## 当前限制

1. 四个道路点只能提供平面约束，无法可靠估计镜头畸变，因此 `k1`、`k2`、`p1`、`p2`、`k3` 固定为零。
2. 参与统一标定的照片应来自同一台相机，并保持相同分辨率、焦距和裁剪方式；程序检查分辨率，但无法自动判断相机、焦距或裁剪来源。
3. 固定车载模式只独立估计一个共同焦距 `f`。如果真实主点偏离中心或 `fx≠fy`，结果会吸收这些模型误差。
4. 导出结果的 `imageSize` 取第一张已完成照片的尺寸，并在计算前要求所有有效视图分辨率一致。
5. 道路宽度与纵向长度的比例必须真实；整体同时缩放只影响平移尺度，不改变理论内参。
6. 几何质量分数是交互提示，不是完整的标定误差评估。
7. 当前布局主要适合宽度不小于 1180px 的电脑屏幕。

## 后续修改建议

1. 增加焦距及裁剪来源的一致性确认项。
2. 增加异常视图的一键排除与重新计算。
3. 增加完整标定会话 JSON 导入。
4. 在有足够观测点时增加镜头畸变参数标定。
5. 增加窄屏及移动端布局。

## 测试

运行 `npm test`。测试覆盖 normalized DLT、已知内参恢复、重复姿态退化拒绝和混合分辨率拒绝。合成测试的真实内参为 `fx=1200`、`fy=1180`、`cx=960`、`cy=540`。
