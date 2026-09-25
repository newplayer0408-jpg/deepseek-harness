# Agent Note: Unsigned community Desktop release from a fork

Status: proposed

[English](2026-09-25-fork-unsigned-desktop-release.md) | 中文

## 问题

本仓库只在开发者机器上构建 Windows 桌面安装包：`package:desktop:win:x64:unsigned` 产出一份本地产物，而现存唯一的发布路径是推送至 DeepSeek 自有下载桶的私有上传序列。因此 fork 无法把安装包交给用户——用户必须克隆仓库并安装 Node.js 与 pnpm，这不是「下载即可运行」。

用发布身份发布 fork 构建并不可接受，其原因在开发（dev）变体上已经确立：electron-builder 从应用标识派生 Windows 安装目录、两个快捷方式名称以及两个卸载注册表键，Electron 从包名派生用户数据目录与单实例锁。两份共享这些取值的安装，在所有真正要紧的意义上就是同一份安装，因而安装或卸载其中一份会波及另一份。所以社区版二进制必须携带自己的身份，而不能复用 `com.deepseek.harness`。

社区版二进制也不应表现得像一个 DeepSeek 部署。发布构建会把强制更新策略源（origin）写进打包后的 manifest，并在启动时以及大约每十分钟轮询它；dsh 共享基础配置还会挂载一个指向 DeepSeek collector 的会话日志导出器。两者对 DeepSeek 官方发布都正确，对 fork 的公开二进制都错误。

## 提案

新增第三种显式产品变体 `community`，由既有的 `DSH_DESKTOP_VARIANT` 输入选择，并复用既有的变体机制。production 与 dev 的行为逐字节保持不变。

### 社区版身份

该变体在代码中钉死唯一身份，而不是从发布标识派生。原因有两点：发布标识属于 DeepSeek 的命名空间；派生会让 fork 的配置失误重新造出这个变体本就是为了防止的碰撞。

| 身份输入 | 社区版取值 | 来源 |
|---|---|---|
| 应用标识（`APP_ID`，以及 `APP_GUID` 的 UUID.v5 输入） | `io.github.newplayer0408.deepseek-harness` | 钉死常量 |
| 产品名、安装目录、可执行文件名、快捷方式名称 | `DeepSeek Harness Community` | 钉死常量 |
| Electron 包名 → 用户数据目录、Chromium profile、单实例锁 | `@newplayer0408/dsh-desktop-community` | 钉死常量 |
| 安装与卸载注册表键 | 由 electron-builder 从应用标识派生 | 应用标识 |
| 产物与输出根标记 | `-community` | `desktopVariantSuffix` |
| Harness 主目录 | `~/.dsh-community` | `defaultDshCommunityHome` |

由于标识是钉死的，社区版构建永不调用 `resolveDesktopAppId`：fork 的 dotenv 文件里写着的发布标识对该变体没有作用，而不是被静默信任。

该变体标记由 `desktopVariantSuffix` 掌管——也就是已经产出 `-dev` 的那个 helper——因此社区版产物名为 `deepseek-harness-<version>-win-x64-community-unsigned.exe`，其 blockmap 随之同名。标记位于 `-unsigned` 之前，从而让产品变体与签名状态并排可读。

### 状态隔离

`~/.dsh-community` 与 `~/.dsh`、`~/.dsh-dev` 平级，由播种开发主目录的同一个早期引导模块播种，在任何 Harness 路径被解析之前完成，且仍让显式的 `$DSH_HOME` 优先。选择平级而非子目录，是为了让发布版或开发版的卸载器——它只删除自身安装注册过的路径——无法顺着目录走进去。

### 不联系上游服务

仅为该变体移除两项上游行为。

**强制更新。** 只有当打包后的 manifest 携带 `dshMandatoryUpdatePolicy` 时，外壳才会构建其策略客户端；`resolveDesktopPolicyConfig(undefined)` 返回 `undefined`，`main.ts` 随后不会创建任何策略实例。因此社区版构建在 `extraMetadata` 中省略该字段，并完全不解析策略源。这是彻底关闭该行为的最小做法：不配置源、不轮询、不会有周期性失败请求，也永不联系 `download.deepseek.com`。把该字段指向占位地址或不可达主机已被否决——两者都保留了一条只为失败而存在的请求路径。

**遥测。** dsh 共享基础配置把未设置的 `DSH_TELEMETRY_MODE` 解析为 `FEEDBACK_ONLY`，因此未经配置的社区版构建会在用户首次记录 `/feedback` 时把一段会话前缀上传到 DeepSeek 的 collector。该变体在同一个早期引导中把 `DSH_TELEMETRY_MODE=DISABLED` 播种进进程环境，于是继承了外壳环境的 Host 子进程在加载组合配置时该导出器行已禁用，不会联系任何 collector。只播种「未设置」的情形：显式设置该模式的运维者保留自己的取值，这与 `$DSH_HOME` 已经优先于变体默认值一致；`DSH_TELEMETRY_DISABLED` 仍是 harness 自身的强制退出开关。

在运行时播种环境、而不是在 CI 里导出一个 shell 变量，正是关键所在。CI 变量描述的是构建进程；只有打包后的应用为自己设置的值，才能到达用户实际运行的 Host。这就是该机制放在变体引导模块中、并在那里断言的原因。

### 许可证与声明

本仓库为 MIT，要求其版权与许可声明随软件副本一同分发，但打包后的应用既未包含 `LICENSE`，也未包含 `THIRD_PARTY_NOTICES.md`。社区版构建通过 `extraFiles` 把二者加入为 `licenses/LICENSE` 与 `licenses/THIRD_PARTY_NOTICES.md`；electron-builder 会把 `extraFiles` 放在可执行文件旁，也就是已放置 Electron 自身 `LICENSE.electron.txt` 与 `LICENSES.chromium.html` 的目录，因此这些声明在安装目录中直接可见，而不会埋在 asar 里。未采用 `extraResources`，因为它会把文件放到 `resources/` 下——该目录的内容由应用加载，而非供用户浏览。打包已携带的任何声明都不会被改动或替换，production 的文件清单保持不变，因此本改动不影响发布产物。

### 发布工作流

一个仅 `workflow_dispatch` 触发的 Windows x64 工作流，在 `windows-latest` 上用规范打包命令构建社区版安装包，运行该命令本就包含的打包运行时冒烟检查，校验产物，并且只把那个 `.exe` 作为 Actions 产物上传。构建 job 持有 `contents: read`，不使用任何 secret。版本仅来自 `apps/desktop/package.json`，没有版本输入，也没有 tag 触发，因此一次手动触发绝不会意外创建公开版本 tag。

创建 GitHub Release 的第二个 job——唯一持有 `contents: write` 者——已存在但默认不生效：只有运维者设置默认为 false 的 `publish` 输入时它才运行。把它留在文件中，是为后续发布步骤保留已评审的 build/publish 拆分，同时让最初若干轮只跑构建。

社区版变体无法经由任何上游路径发布，这一点是被强制而非仅靠约定。`createDesktopUploadPlan` 会在读取完成记录或任何产物之前就拒绝非 production 变体；`createInstalledUpdateBuilderConfig`——已安装更新资格流程的入口——则在原有测试部署设置要求之外，显式要求 production 变体。工作流本身从不设置任何上传、COS 或自动更新设置，本仓库的任何工作流也都无法触达上游发布序列。

### 品牌

两个 README 都声明该构建为非官方社区构建，不由 DeepSeek 发布、认可或提供支持；同样的声明也是 publish job 将来写入的发布说明的一部分。production 身份保持不变，因此该声明是把两者区分开的诚实做法：应用标识、产品名与快捷方式不可能既保持与发布版兼容、又同时宣告这是 fork。

## 曾考虑的替代方案

**沿用发布身份发布，并在 README 里说明。** 不采用：它重新造出开发变体本就是为了消除的共享安装隐患；已安装社区版的用户，其原有安装会被替换或删除。

**像 `dev` 那样从发布标识派生社区版身份。** 不采用：后缀仍落在 DeepSeek 的命名空间内，而且派生会让为本地发布工作配置的发布标识泄漏进公开的社区版二进制。

**社区版同样要求 `DSH_DESKTOP_APP_ID`，并与钉死值做校验。** 不采用：该校验只是重述钉死已经保证的事，还会把 fork dotenv 文件中一个无害的发布设置变成构建失败。

**把强制更新策略指向 fork 自有的源，或指向一个不可达的源。** 不采用：前者要求 fork 运行一个只为回答「无更新」的策略服务；后者会在应用里留下周期性失败请求——比完全不轮询更糟的用户可见结果。

**在 CI 工作流里导出 `DSH_TELEMETRY_MODE` 来关闭遥测。** 不采用：它只描述 CI 进程。真正联系 collector 的是打包后的应用，不是构建过程。

**仅通过改产品名让差异体现在窗口标题上。** 作为唯一手段不充分：产品名确实必须不同，也确实不同，但用户需要的是书面声明，而不是从窗口标题推断。

**另写一套打包实现，直接产出社区版安装包。** 不采用：`package-target.ts` 已经掌管准备、身份、Office 路径预算、打包运行时冒烟检查与打包日志。平行实现必须把这些全部重新挣得一遍，且必然漂移。

## 验收标准

- `DSH_DESKTOP_VARIANT=community` 产出名为 `deepseek-harness-<version>-win-x64-community-unsigned.exe` 的安装包，位于 `.dsh-build/win-x64-community/`，并带有同名 blockmap，且不存在任何命名得像发布版或开发版的产物。
- 已安装应用、安装目录、两个快捷方式、两个卸载注册表键与其 Electron 用户数据目录，均不同于发布版与开发版取值；社区版安装可与二者并存。
- 社区版安装读写 `~/.dsh-community`，并保持 `~/.dsh` 与 `~/.dsh-dev` 不受影响，卸载亦然。
- 社区版打包 manifest 不携带 `dshMandatoryUpdatePolicy`；外壳不启动策略客户端，也不发出策略请求。
- 除非运维者设置了模式，社区版 Host 以 `DSH_TELEMETRY_MODE=DISABLED` 运行。
- `LICENSE` 与 `THIRD_PARTY_NOTICES.md` 在社区版安装目录内可读。
- production 与 dev 的身份、产物名、输出根、打包 manifest 字段与解析出的策略均不变。
- 工作流的默认触发会构建并上传社区版 `.exe`，不创建 tag 或 Release，也不使用任何上游凭据。

## 风险

fork 必须把 `io.github.newplayer0408.deepseek-harness` 与 `@newplayer0408/dsh-desktop-community` 保留给该变体；改动其中任一者都是新身份、新安装与数据足迹，而不是重命名。版本仍为 `0.1.7-rc.1`，上游用户不会把它误认为已发布版本；但开始跟踪上游版本的 fork 需要自己的版本策略。`DSH_TELEMETRY_MODE=DISABLED` 停止会话日志导出；DeepSeek 会话日志贡献器是另一条请求路径，它标注用户用自己的凭据发出的模型请求，不在本次范围内。钉死的 LibreOfficeKit 引擎使社区版输出根与开发版处于同一深度、仍在 Windows `--program-directory` 预算内，这一点由打包断言而非假定。托管 runner 上的首次触发将是冒烟阶段与路径预算在该环境成立的首个证据；在此之前，二者仅在本地得到验证。GitHub Release job 默认不生效；若运维者在 tag 策略尚未确定时设置 `publish`，创建的 Release 会落在 fork 专属 tag 上，而非上游命名空间。
