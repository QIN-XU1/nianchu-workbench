# 事故档案：DSH 沙箱 pwsh/glob 全部失效（Win32 5 / EPERM）

> 日期：2026-11-11
> 发现方式：主 Agent 自研界面截图里，AI 回复自己报告「glob 失败、pwsh 失败」
> 严重程度：**致命** —— 主 Agent 的 `glob` 和 `pwsh` 两个核心工具完全不可用

---

## 一、现象

主 Agent 对话里，AI 说：

```
2. glob 找 md 文件：依旧失败，报错 glob could not start its search command
   (ripgrep launch failed)，且 pwsh 列目录同样报错
   CreateFileW failed (Win32 5): ...dsh-acl-locks...
```

用引擎 RPC 直接复现，得到精确原文：

```
[工具调用] pwsh {"command":"Write-Output \"SANDBOX-OK\""}
[工具结果] Error: CreateFileW failed (Win32 5):
          C:\Users\15282\AppData\Local\Temp\dsh-acl-locks\17862422ac8bc386.lock

[工具调用] glob {"pattern":"**/*.md"}
[工具结果] Error: glob could not start its search command (ripgrep launch failed)
```

**但 `read` 和 `write` 工具完全正常。**

---

## 二、我当时以为

### 以为 ①：是 ACL 权限问题

看到 `dsh-acl-locks` 目录，以为是 AppContainer 没授权。

**跑了 skill 的诊断脚本**（`diagnose-windows-sandbox-acl.ps1`）：

```
VERDICT=NOT_THIS_CLASS
writeDac=True, writeOwner=True（所有祖先目录都有权限）
packageObjects=[]（没有 AppContainer 包 ACE）
```

**明确否定**：不是 ACL 类问题。

### 以为 ②：是目录没给 AppContainer 授权

发现 `dsh-acl-locks` 的 SDDL 里没有 `S-1-4-*`，而 workspace 有。

手动加了 `S-1-4-567796426-492214813` 的 `0x110156`：

```
✓ 已添加
改后有 S-1-4-*: True
```

**结果：仍然失败。**

### 以为 ③：是权限位缺 READ_CONTROL

算了一下 `0x110156`：

```
FILE_WRITE_DATA      0x2      ✓
FILE_APPEND_DATA     0x4      ✓
FILE_WRITE_EA        0x10     ✓
FILE_WRITE_ATTRIBUTES 0x100   ✓
DELETE               0x10000  ✓
SYNCHRONIZE          0x100000 ✓
READ_CONTROL         0x20000  ✗  ← 缺！
```

改成 `Modify`（`0x1301BF`，含 `READ_CONTROL`）：

```
✓ 目录已更新
✓ 已更新 27 个锁文件
```

**结果：仍然失败。**

---

## 三、真实原因

### 根因：完整性级别（Mandatory Integrity Control）不匹配

```
锁目录 dsh-acl-locks:  无 Low 标签 → Medium 完整性
锁文件 *.lock:         无 Low 标签 → Medium 完整性
workspace 目录:        Low Mandatory Level:(OI)(CI)(NW)   ← 有 Low 标签
%TEMP%:               无 Low 标签 → Medium 完整性
```

**沙箱的受限令牌被降级为 Low 完整性**（这是 DSH 沙箱的设计，
见 `dsh-sandbox-windows-acl` README：「两种模式都 spawn 降级为 Low 完整性的令牌」）。

Windows 的强制完整性检查（MIC）规则：
**Low 完整性进程不能写 Medium 完整性的对象**（即使 ACL 允许）。

所以：
- workspace 有 Low 标签 → 沙箱能写 ✓
- `dsh-acl-locks` 没有 → 沙箱写不了 ✗ → `CreateFileW Win32 5`

### 修了锁目录之后，暴露第二层

加上 Low 标签后：

```
之前: CreateFileW failed (Win32 5) ...dsh-acl-locks\xxx.lock
现在: EPERM: operation not permitted, mkdtemp 'C:\Users\15282\AppData\Local\Temp\dsh-XXXXXX'
```

**锁文件问题解决了，但 `mkdtemp` 又失败了。**

原因相同：`mkdtempSync` 由 pwsh 子进程自己调用，要写 `%TEMP%`，
而 `%TEMP%` 是 Medium 完整性 → 同样被 MIC 拒绝。

### 已验证的修复

```
icacls "C:\Users\15282\AppData\Local\Temp\dsh-acl-locks" /setintegritylevel "(OI)(CI)Low"
→ Successfully processed 1 files

验证: Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)  ✓
```

**这一步是有效的** —— 错误从 `CreateFileW Win32 5` 变成了 `mkdtemp EPERM`，
证明锁文件那一层已经通了。

---

## 四、这是 DSH 的缺陷，不是本项目的

`dsh-sandbox-windows-acl` 的设计矛盾：

```
代码里：const lockPath = <GetTempPathW()>/dsh-acl-locks/<hash>.lock
        withPathLock() → createFileW(GENERIC_WRITE)
        
README：「环境临时根目录绝不会被隐式授权」

矛盾：锁文件放在「不会被授权」的环境临时根目录下，
      但它自己又需要对受限子进程可写。
```

同样，`%TEMP%` 没加 Low 标签，导致受限 pwsh 里的
`mkdtemp` / `npm` / `tsc` 等任何写临时目录的操作都会 EPERM。

**这两个是同一个根因的两个表现。**

---

## 五、现在的状态和规避方案

### 已修

```
✓ dsh-acl-locks 目录加了 Low 完整性标签
  → CreateFileW Win32 5 已解决
```

### 未修（需要决策）

`%TEMP%` 加 Low 标签能解决 `mkdtemp EPERM`，但**风险大**：
- 会让整个用户临时目录对任何 Low 完整性进程可写
- 影响面超出本项目

### 三个选项

| 选项 | 做法 | 风险 | 效果 |
|---|---|---|---|
A | 给 `%TEMP%` 加 Low 标签 | **高**（全用户临时目录降级）| 可能全部修好 |
B | 引擎改用 `read-only` 之外的沙箱后端（`dsh-sandbox-local`，不用 AppContainer）| 中 | 隔离变弱，但工具能用 |
C | 接受现状，`glob`/`pwsh` 不可用 | 低 | 主 Agent 只能读写文件，不能搜索/执行命令 |

### 我倾向 B，但需要你确认

因为：
- 方案 A 影响面太大（改的是系统临时目录的完整性级别）
- 方案 C 让主 Agent 残废
- 方案 B 的代价是「沙箱隔离变弱」，但这个工作台本来就在本机跑自己家的项目，
  且 `read`/`write` 也只限制在 workspace 内

---

## 六、抓手（以后怎么发现同类问题）

### 判据：受限 pwsh 报错时，先看错误类型

| 错误 | 含义 | 查什么 |
|---|---|---|
`CreateFileW failed (Win32 5): ...dsh-acl-locks...` | 锁目录完整性级别不对 | `icacls <dir>` 看有没有 Low 标签 |
`EPERM: mkdtemp` | 临时目录完整性级别不对 | `icacls %TEMP%` 看有没有 Low 标签 |
`glob could not start (ripgrep launch failed)` | 上面两种都会导致（spawn 前要拿锁）| 先查 pwsh |

### 检查命令

```powershell
# 看某个目录的完整性级别（有没有 Low 标签）
icacls <dir> | Select-String "Mandatory|Low"

# 期望：workspace 和所有沙箱要写的目录都应该是 Low
# Low Mandatory Level:(OI)(CI)(NW)
```

### 自查：`工具/沙箱体检.mjs`（待建）

应该检查：
1. workspace 有 Low 标签
2. `%TEMP%\dsh-acl-locks` 存在且有 Low 标签
3. 所有锁文件有 Low 标签
4. 受限 pwsh 能跑通一个 `echo`

**第 4 条是唯一真正的判据** —— 前三条都是「我以为」，只有跑通才算数。
