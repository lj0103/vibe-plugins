# 扣子公开视频解析服务

这是一个替代 ALAPI 的自托管方案。服务使用开源 `yt-dlp` 解析用户有权处理的公开视频链接，不需要购买第三方 API Token。

## 能做什么

- 返回视频标题、封面、作者、时长和可用媒体地址。
- 适配抖音、B站、小红书、西瓜、微博、TikTok 等 `yt-dlp` 当前支持的平台。
- 提供 FastAPI 自动生成的 OpenAPI 文档，可导入扣子 Skill。
- 可用你自己设置的 `SERVICE_TOKEN` 保护公开接口。

媒体地址通常有有效期。平台结构发生变化时需要升级 `yt-dlp`；官方支持列表也明确说明，列出的站点并不保证始终可用。

## 使用边界

仅处理你本人拥有、已获授权或平台明确允许下载的视频。服务不会绕过登录、付费、DRM 或其他访问控制，也不承诺移除平台水印。

## 本地运行

```bash
cd /Users/liujing/Documents/VibeCoding/plugins/coze-video-parser
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 7860
```

打开：

- 接口文档：`http://127.0.0.1:7860/docs`
- OpenAPI：`http://127.0.0.1:7860/openapi.json`
- 健康检查：`http://127.0.0.1:7860/health`

测试请求：

```bash
curl -X POST http://127.0.0.1:7860/api/video/parse \
  -H 'Content-Type: application/json' \
  -d '{"url":"你有权处理的视频分享链接"}'
```

## Docker 部署

```bash
docker build -t coze-video-parser .
docker run --rm -p 7860:7860 \
  -e SERVICE_TOKEN='替换为你自己生成的长随机字符串' \
  coze-video-parser
```

任何支持 Docker 的平台都可以部署。使用免费托管方案时，要注意休眠、流量、网络出口和服务条款限制；免费额度可能随时调整。

## 接入扣子 Skill

1. 部署服务并获得 HTTPS 域名，例如 `https://video-parser.example.com`。
2. 将 `coze-openapi.yaml` 中的 `https://YOUR-DOMAIN.example.com` 改为实际域名。
3. 在扣子中创建 API Skill，导入修改后的 `coze-openapi.yaml`。
4. 鉴权方式选择 API Key。
5. 参数位置选择 Header，名称填写 `X-API-Key`。
6. 值填写部署平台环境变量 `SERVICE_TOKEN` 中的同一个字符串。
7. 调试 `parseVideoLink`，传入一个你有权处理的视频分享链接。

这里的 `X-API-Key` 是你自己为服务设置的访问口令，不属于 ALAPI，也不会产生第三方 API 调用费。

如果只在可信的本地环境测试，可以不设置 `SERVICE_TOKEN`；公开部署时不要关闭鉴权。

## 测试

```bash
pytest -q
```

## 已知限制

- 快手未出现在当前 `yt-dlp` 官方支持列表中，不能保证可用。
- 某些平台需要登录 Cookie；本服务默认不接收或保存 Cookie。
- 部分站点会限制数据中心 IP，免费托管平台可能解析失败。
- 返回的是解析时可用的媒体地址，不是永久存储地址。

## 参考

- [yt-dlp 官方仓库](https://github.com/yt-dlp/yt-dlp)
- [yt-dlp 官方支持站点列表](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)
