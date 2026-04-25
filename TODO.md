### 可以在行末尾 @自己
  - 只看最后一个非空行
  - 命中 continuation marker 才触发
  - 不允许和 @mention 同时生效时抢路由
  - 继续调用还是走同一条 worklist，不新开旁路
  - 用现有 maxDepth 兜底，防止自循环
