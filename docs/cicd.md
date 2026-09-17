# CI / CD

## 一、GitHub Actions（真跑在 GitHub 上）

`.github/workflows/ci.yml`，push 与 PR 都会触发，三个 job：

| job | 内容 |
|---|---|
| `test` | Node 18 / 20 / 22 三档矩阵：语法检查 → 单元测试 → 两个合成样例仍可跑 |
| `scan` | 扫描门禁（语法 / 敏感信息 / 静态规则 / 依赖成分） |
| `docker` | 构建镜像 → 校验产物齐全 → 容器内跑单元测试 |

零第三方依赖，所以没有安装步骤，也没有锁文件校验的麻烦。

## 二、本地流水线（与另一条流水线同一套形状）

```bash
bash ci/ci.sh        # push -> build -> test -> scan
bash cd/deploy.sh --image=<image:tag> [--env=prod]
bash pipeline.sh     # 串起来；CI 产出的镜像交给 CD
```

### CI 四个阶段

```
push   提交并推送，记下 commit
build  docker build，并校验镜像里 src / test / examples 齐全
test   容器内 node --test（非 TTY 下要加 --test-reporter=spec 才读得懂）
scan   ci/scan.js，门禁 CRITICAL>0 或 HIGH>3 即拦截
```

每阶段计时，失败即中断，日志与产物落在 `ci/reports/`。

### CD 五个阶段

```
precheck   镜像必须存在
staging    在镜像里跑一次生成 + 健康检查，连续 N 次通过才继续
           （不过就到此为止，绝不进 prod）
prod       把镜像标记为 story-workflow:stable
gate       再跑一次健康检查门禁
rollback   门禁不过就把 stable 指回上一个 good 版本，并按基线复检
```

「上一个 good 版本」记在 `cd/versions.json`，成功发布时更新。

### 这个项目里"部署"是什么意思

它是 CLI / 库，没有常驻服务。所以**部署 = 镜像打上环境 tag，并在该镜像里真跑一次生成与健康检查**；**回滚 = tag 重新指向上一个 good 版本，再复检**。语义和常驻服务不同，但「先验证再放行、失败能退回去」这条是一样的。

## 三、门禁判据 = 运行期判据

`cd/health_gate.js` 直接 `require('../src/health').evaluate()`，不另写一套阈值。

这条是刻意的：另写一套就会出现「门禁过了但线上不健康」。同一个 `evaluate()`，运行期用它判健康，发布时用它判能不能放行。

判的是这四个指标（详见 README 工程纪律章节）：

```
pending.awaiting            待归因积压
pending.oldestAgeSec        最老一条的账龄
proposals.awaiting          未确认的路径建议
lastRun.noRegressionPassed  上次生成是否过不回退清单
```

## 四、哪些是真的，哪些是模拟的

**真做**：

- 语法编译扫描（`node --check` 逐文件）
- 敏感信息扫描（密钥、私钥、通用 token 三个正则；行尾写 `nosec` 可抑制）
- 静态规则扫描（禁止联网调用、禁止 fetch、避免外部命令——因为本项目承诺运行时不联网）
- 依赖成分扫描（读 package.json；本项目零依赖所以必然为空）
- 容器内单元测试、构建产物校验
- 健康检查门禁与回滚复检

**模拟**：

- 镜像漏洞扫描。本机没有 trivy，也没有漏洞库，两条 CVE 是写死的示例，输出里标 `[模拟]`。
  真要接，把 `ci/scan.js` 的 `scanImage()` 换成 trivy 调用即可，门禁逻辑不用动。

- 镜像仓库也是本地 docker，没有推到远程仓库这一步。

## 五、演练

```bash
# 正常发布到 prod
bash cd/deploy.sh --image=story-workflow:<tag> --env=prod --times=2 --interval=500

# 回滚演练：跳过真实门禁，强制判定 prod 不健康，验证能否退回上一个 good
bash cd/deploy.sh --image=story-workflow:<tag> --env=prod --simulate-prod-failure
```

## 六、产物

```
ci/reports/ci-<build>.log      每次 CI 的日志
ci/reports/last_build.json     CI 产出（build / commit / image），供 CD 读取
ci/reports/scan-*.json         扫描报告（加 --json 时）
cd/reports/gate-<env>-*.json   每次门禁的采样与判定
cd/versions.json               good / bad 基线与历史
```

`ci/reports/` 与 `cd/reports/` 已加入 `.gitignore`，只有 `cd/versions.json` 入库。
