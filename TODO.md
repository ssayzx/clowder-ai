### start

nvm use system # 切换回系统node 20

### tips
#### 持久化
 你的启动方式是关键原因：

  pnpm start:direct -- --quick
  package.json 里 start:direct 默认等价于带了：
  --profile=opensource

  而 opensource profile 明确配置了：
  MESSAGE_TTL_SECONDS=86400
  THREAD_TTL_SECONDS=86400
  TASK_TTL_SECONDS=86400
  SUMMARY_TTL_SECONDS=86400
  REDIS_PROFILE=opensource

  也就是：数据确实进 Redis，但聊天线程/消息只有 1 天 TTL。--quick 只跳过构建，不改变 TTL。
  你想长期保存，改用：
  pnpm start:direct -- --quick --profile=production
  pnpm start:direct -- --profile=production

  production profile 的 TTL 是 0，表示永久保存，同时仍使用持久化 Redis。

### 可以在行末尾 @自己
  - 只看最后一个非空行
  - 命中 continuation marker 才触发
  - 不允许和 @mention 同时生效时抢路由
  - 继续调用还是走同一条 worklist，不新开旁路
  - 用现有 maxDepth 兜底，防止自循环
