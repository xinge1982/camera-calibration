# Road Calibration UI

一个无前端框架依赖的多照片道路平面标定工具。每张照片分别设置四个道路标定点，完成后使用平面单应矩阵约束计算统一相机内参。

## 项目结构

```text
index.html                       页面结构
css/styles.css                   页面样式
js/app.js                        照片、交互与标定算法
photos/                          本地照片目录
photos/manifest.json             浏览器照片清单
scripts/build-photo-manifest.mjs 清单生成脚本
```

## 使用方法

1. 把 JPG、PNG、WebP、BMP、GIF 或 SVG 图片复制到 `photos/`。
2. 运行 `node scripts/build-photo-manifest.mjs` 生成照片清单。
3. 运行 `python3 -m http.server 8080` 并访问 `http://localhost:8080`。

也可以在页面中直接选择本地照片文件夹，无需生成清单。

## 标定点定义

- 左上、右上：左右车道线与图像边缘的交点。
- 左下、右下：左右车道线与道路边缘的交点。

至少需要完成三张不同视角照片。工具使用每张照片四点建立道路平面单应矩阵，再通过多视图平面约束估计统一的 `fx`、`fy`、`cx`、`cy`。四点无法可靠估计镜头畸变，因此导出结果中的畸变参数保持为零；生产级标定建议另配棋盘格或 AprilTag 标定板。
