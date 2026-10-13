# mud-flows

MUD 流程定义 Provider（T28 拆包）。步表数据 + 编译纯层，判据语料节奏独立演化。

## API（公共面）

- `./login`：`login` 流程（五路径：直连/顶号/密码错/验证码/断线重连——判据原文见 A.3）
- `./fullme`：`fullme` 流程（主链/stale 自愈/abort/三退出路径/URL 槽化断言）
- `./captcha`：`fetchCaptcha` 取图纯件（`CaptchaFetch`/`CaptchaResponse` 类型；Node fetch IO，零依赖）

## 依赖

- `mud-workflow`：`WorkflowRecord` type-only（契约层词汇）

## 纪律与 Known Limitations

- **D7 状态面归属**：captcha 的等待状态（`captchaWaits`/`emitCaptcha`/`resolveCaptcha`）留 `mud` 引擎（service.ts workflowIoFor 缝内）——本包只有无状态取图纯件。
- 本包 E2E 测试（login 五路径/fullme 主链）是引擎集成测试，**留 mud-core3**（薄壳期）随 T28.4 归 `mud`——本包 tests 暂空，行为由 core3 E2E 覆盖。
- 判据原句 A.6 纪律：逐条实录，不得凭印象写正则。
