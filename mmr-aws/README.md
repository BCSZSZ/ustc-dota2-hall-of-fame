# 共享登记 API

GitHub Pages 的登记、首页、数据和分队页面共用 AWS 东京区的 HTTP API、Lambda 和 DynamoDB。Lambda 返回 `{revision, ratings, aliases, updatedAt}`，保存时用 DynamoDB 条件写入检查版本。

## 发布

用 Node 22 生成含 Lambda 源码的 CloudFormation 模板。首次部署保持 `WritesEnabled=false`，导入正式数据并核对后再开放写入。

```bash
mmr_template=$(mktemp)
node mmr-aws/render-template.mjs > "$mmr_template"
aws --profile personal --region ap-northeast-1 cloudformation deploy \
  --stack-name ustc-dota2-mmr --template-file "$mmr_template" \
  --capabilities CAPABILITY_IAM --parameter-overrides WritesEnabled=false
```

部署输出中的 `Endpoint` 是前端唯一的共享数据地址，`TableName` 是 DynamoDB 表名。DynamoDB 的单条记录用字符串键 `id=state`。 `revision` 是数字，`ratings` 和 `aliases` 是 JSON 字符串，`updatedAt` 是 ISO 时间字符串或 DynamoDB NULL。

## 迁移和验证

1. 新 API 保持只读。确认从 GitHub Pages 来源发出的 GET 和 OPTIONS 正常，并从国内网络验证 HTTPS 入口。
2. 通过 `MMR_READ_ONLY=true` 暂停旧 Worker 写入，确认旧的无修改 PUT 已返回 503，再读取 D1 的最终状态。将状态导入 DynamoDB，保留原版本号和更新时间，对照两端返回逐字段核对。
3. 重新部署同一 AWS 栈，传入 `WritesEnabled=true`。验证保存、版本冲突和页面刷新，然后把 `site/shared-mmr.js` 的地址改为 AWS 输出的 `Endpoint` 并更新静态脚本版本。

AWS 开放写入后，如需回切，先暂停 AWS 写入并把 DynamoDB 的最新状态同步回 D1，再重新开放旧入口。
