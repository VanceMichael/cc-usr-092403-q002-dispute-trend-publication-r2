# 消费争议趋势证据仓

这是一个面向消费争议归集和月度趋势分析的纯后端工程，主要技术为 Node.js 22、TypeScript、Fastify、Kysely 与 SQLite。当前代码提供数据库连接、可重复迁移、健康检查、自动化测试和 Docker 运行基础。

SQLite 数据文件默认位于项目目录的 `data` 下，也可由 `DATABASE_PATH` 指向工作目录内的其他位置；监听端口通过 `PORT` 配置。服务不连接外部数据库、缓存或消息系统。

执行 `npm run db:migrate` 初始化数据库，`npm test` 运行测试，`npm run dev` 启动开发服务。Docker 镜像构建过程中会先执行测试和编译。

## 趋势口径发布流程

- **批次接收**：`POST /sources` 登记来源；`POST /sources/:sourceKey/batches` 导入批次。同一 `(source_key, batch_key)` 重放返回首次结果，事件与撤回按业务键幂等去重，来源水位只升不降，整批事务化落库。
- **口径版本**：`POST /merchant-identities` 追加商家归并的有效区间（身份纠正不改历史行）；`POST /taxonomy/versions` 创建不可变的分类词典版本，类别带有效区间。
- **归类**：`POST /classification/runs` 创建归类作业，`POST /classification/runs/:id/advance` 分页推进，页内事务保证中断后从检查点继续；规则只生成候选。`POST /classification/candidates/:id/decisions` 以只追加方式记录人工确认、拆分或合并，候选与历史处置不被覆盖。
- **发布**：`POST /reports/:month/publish` 锁定当月来源水位、分类版本与排除理由，把计入的事件连同有效口径冻结进快照；迟到投诉、撤回与身份纠正只体现在下一版本。携带相同 `request_key` 的重复发布返回首次结果。
- **月报**：`GET /reports/:month` 返回当期数字、与上一发布版的差异来源（补报/撤回/合并/身份纠正/归类变更）与未决候选数；样本数低于 `MIN_CELL_SIZE`（默认 5）的细分单元被抑制。`GET /reports/:month/drilldown` 需要 `x-actor` 头，且只能下钻到 `PUT /viewers/:actor/scopes` 授予类别范围内的去标识化证据。

## 开发检查

- 编译或构建：`npm run build`
