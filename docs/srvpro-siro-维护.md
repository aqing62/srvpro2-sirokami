# srvpro-siro:50010 维护手册

> 对象：`ygopro3.cn:50010` 白神服游戏服务器（srvpro2）
> 本文件由维护时整理，改动历史见本仓库 git log；服务器上另有一份副本。

---

## 0. 铁律（先看这个）

1. **这台机器是共用的**，同机还跑着别人的服务：
   `srvpro-eschatology:50020`、`srvpro3_xiao:50005`、`siro-web`、`website`、`livekit-*`、`xray`、`windbot`、`github-runner`。
   → **只操作 `srvpro2_siro:50010`**，**永远不要** `pm2 restart all` / `pm2 delete all`。
2. 服务器上这个仓库的工作区**有未提交的改动**（`admin_user.json`、`card_merge_map.json`、`src/feats/ladder/*.ts` 等）。
   → **不要盲目 `git pull`**，会顶掉这些改动。
3. 重启会**中断正在进行的对局**，挑没人的时候做。
4. 改动只放在 `srvpro-siro` 目录里；**不要**碰 `/root/servers/ygopro/cards-pre`（它是共用目录，别台服务也在用）。

---

## 1. 位置清单

| 东西 | 路径 |
|---|---|
| 游戏服目录 | `/root/servers/ygopro/srvpro-siro` |
| 启动入口 | `dist/index.js`（pm2 里叫 `srvpro2_siro:50010`，id=8） |
| 日志 | `/root/.pm2/logs/srvpro2-siro-50010-out.log` / `-error.log` |
| 禁限表 | `cards-diy/lflist.conf`（**放在这个目录内才只影响本服务**） |
| 组卡校验补丁脚本 | `tools/apply-patches.cjs`（幂等，可反复跑） |
| 补丁目标 | `src/utility/check-deck.ts`（源码）、`dist/src/utility/check-deck.js`（运行中的编译产物） |
| 内核 | `node_modules/koishipro-core.js`（包内自带 `dist/vendor/wasm_cjs/libocgcore.wasm`） |
| 卡库 | `cards/cards.cdb`（→ `../../ygopro-database/...`）、`cards-diy/`、`cards-pre/` |
| 本地仓库（Windows） | `E:\ygopro-server-src`（**sparse-checkout**，只签出 `src/feats/ladder`、`src/ui/Duel/PlayMat`；要改别的上游文件先 `git sparse-checkout add <路径>`） |

---

## 2. 日常维护：三件事

### 2.1 换内核（ocgcore）

内核 wasm 是 **`koishipro-core.js` 这个包自带的**，换内核 = 升这个包。

```bash
cd /root/servers/ygopro/srvpro-siro
npm i koishipro-core.js@<新版本> --no-audit --no-fund     # 先看 package.json 里当前的固定版本
# 版本号请保持【精确锁定】（不要 ^），内核不该被 npm i 随意漂移：
#   "koishipro-core.js": "1.5.5"
sha256sum node_modules/koishipro-core.js/dist/vendor/wasm_cjs/libocgcore.wasm   # 记下指纹核对
pm2 restart srvpro2_siro:50010
```

已核对过的版本（2026-10 更新记录）：

| 版本 | libocgcore.wasm 大小 | SHA256 |
|---|---|---|
| 1.5.4（旧） | 1,098,591 | `d132440bf272694236195859beb94384bce41ac3b9c5cabb01ff4c79184cfe3e` |
| **1.5.5（现用）** | **1,100,684** | `33c16bcbb6f88ef0e5b22ba0576d76fd6577892aa8cc287962ae9cee68572524` |

> 注意：`npm i` **只动 `node_modules/`**，不会碰 `src/`、`dist/`、`lflist.conf` —— 所以**升内核不会顶掉下面的补丁**（已实测验证）。

### 2.2 更新代码 / 重新构建之后

```bash
cd /root/servers/ygopro/srvpro-siro
# （如需拉代码，先确认没有要保留的未提交改动）
npx tsc                                   # 重新构建 dist
node tools/apply-patches.cjs              # ★ 重新打本地补丁（幂等，能从旧版补丁自动升级）
pm2 restart srvpro2_siro:50010
```

- 脚本打不上时会**报警告并以退出码 1 结束**，不会静默跳过 —— 那通常意味着上游改动了这一段代码，需要人工看一眼。
- 每次打补丁都会生成 `*.bak-<时间戳>` 备份。

### 2.3 更新卡库 / 禁限表

- **卡库**：`cards-pre/`（测试版先行卡）与 `cards-diy/`；卡库里每张卡的 `alias` 字段就是「同名卡」关系，**新卡发布时随卡库一起更新，不用人工维护**。
- **禁限表**：`cards-diy/lflist.conf`
  - 表头 `$genesys 100` = 卡组总分上限；每个块（`!ReGenesys DIY`、`!DIY_Sirokami`）是一个可选禁限表，客户端按序号选。
  - 想临时关掉全部校验（回到"什么都不拦"）：`mv cards-diy/lflist.conf cards-diy/lflist.conf.off && pm2 restart srvpro2_siro:50010`
  - 现用文件与本地 `D:\YGO\diy\lflist.conf` 一致，md5 `cd5e4c32ff18171f8608d058bf33fc5c`。

---

## 3. 组卡校验补丁（为什么要打、改了什么）

### 改动

`src/utility/check-deck.ts` / `dist/src/utility/check-deck.js`：

```diff
  const countCode = cardData.ruleCode || cardData.alias || code;   // 同名合计用（保持不变）
  ...
- allCardCodes.push(countCode);
+ // 查分/查限的卡号：自己号在 lflist 里有分就用自己号，否则退回 countCode（别名/同名卡继承）
+ let lflistCode = code;
+ if (lflist) {
+     const genesys = lflist.creditLimits && lflist.creditLimits.find((c) => c.identifier === 'genesys');
+     const ownCredit = genesys && genesys.entries && genesys.entries.find((e) => e.code === code);
+     if (!(ownCredit && ownCredit.credit > 0)) lflistCode = countCode;
+ }
+ allCardCodes.push(lflistCode);
```

### 分值规则（最终确定的版本）

```
① 这张卡自己在 lflist 里有 $genesys 分值  → 用【自己的分】
② 自己没分                                → 用 alias（CDB 里的同名卡链接）那张的分
③ 都没有                                  → 0 分
同名合计最多 3 张：仍然用 countCode（官方「规则上视为同一张卡」的规则，不要动）
```

举例：

| 卡 | 自己分 | alias 指向 | 结果 |
|---|---|---|---|
| 白龙之落胤 73819701 | 20 | 阿不思的落胤(1) | **20**（用自己） |
| 阿不思的落胤 68468459 | 1 | — | 1 |
| 朔夜时雨 52038443 | 无 | 52038441 朔夜时雨(2) | **2**（继承） |
| 鹰身女妖的羽毛扫 18144508 | 无 | 18144506(5) | **5**（继承） |
| 第13人的埋葬者 效果版 49811442 | 4 | 通常版(无分) | **4** |
| 第13人的埋葬者 通常版 32864 | 无 | alias=0 | **0** |

### 为什么不用维护"同名卡名单"

同名关系来自 **CDB 的 `alias` 字段**，分值来自 **lflist 的 `$genesys`**，两者都是**随卡库/禁限表更新一起变**的既有数据；代码里只有上面这几行判断，**没有任何卡号硬编码**。所以游戏王每天出新卡时**不需要做任何检测或登记**。

---

## 4. 改完必做的验证

1. 重启用例（这三条能对上就说明规则生效）：
   - **白龙之落胤** → 按 20 分算（不按阿不思的 1 分）
   - **3 张融合 + 1 张置换融合** → 判同名超 3 张
   - 一套总分 >100 的卡组（例：114 分的鹰身女郎）→ 进房被拦
2. 内核指纹：`sha256sum node_modules/koishipro-core.js/dist/vendor/wasm_cjs/libocgcore.wasm`
3. 补丁在位：`grep -n "allCardCodes.push(lflistCode)" dist/src/utility/check-deck.js`
4. 服务健康：
   ```bash
   pm2 list | grep srvpro2_siro
   ss -ltnp | grep 50010
   tail -40 /root/.pm2/logs/srvpro2-siro-50010-error.log | grep -E "ERROR|TypeError"
   ```
5. **确认没动到别人**：重启前后其它服务的 pid 应完全不变。

---

## 5. 回退

```bash
cd /root/servers/ygopro/srvpro-siro

# 只回退补丁（用最早那代备份 = 上游原始代码）
cp -a src/utility/check-deck.ts.bak-<最早时间戳>  src/utility/check-deck.ts
cp -a dist/src/utility/check-deck.js.bak-<最早时间戳> dist/src/utility/check-deck.js

# 只关掉禁限表校验
mv cards-diy/lflist.conf cards-diy/lflist.conf.off

# 内核回退
npm i koishipro-core.js@1.5.4 --no-audit --no-fund

pm2 restart srvpro2_siro:50010
```

---

## 6. 本地（Windows）仓库说明

- 位置：`E:\ygopro-server-src`，远端 `git@github.com:aqing62/srvpro2-sirokami.git`（分支 `master`）
- 是 **sparse-checkout**：只有 `src/feats/ladder`、`src/ui/Duel/PlayMat`。
  新增/提交稀疏范围外的文件（例如 `tools/`）要用 `git add --sparse <文件>`。
- 推送：`git -c url."git@github.com:".insteadOf="https://github.com/" push origin HEAD`
- `npm run build` 在本仓库跑不通（缺 `scripts/clean-dist.js`），构建在服务器上做。
