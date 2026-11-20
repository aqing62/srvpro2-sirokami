#!/usr/bin/env node
/**
 * 本地补丁：组卡校验里「查分/查限」用哪个卡号
 * ─────────────────────────────────────────────────────────────
 * 背景（分值规则）
 *   ① 这张卡自己在 lflist 里有 $genesys 分值 → 用**自己的分**
 *   ② 自己没分 → 按别名（CDB 的 alias，即同名卡的另一种印法）继承原卡的分
 *   ③ 都没有 → 0 分
 *
 *   例：白龙之落胤 73819701 自己有 20 分（alias 指向阿不思的落胤，但那只有 1 分）
 *       → 必须按自己算 20 分，不能跟着 alias 变 1 分
 *       朔夜时雨 52038443 自己 0 分、alias 指向 52038441（同名，2 分）→ 按 2 分
 *       第13人的埋葬者 效果版 49811442 自己有 4 分 → 4 分
 *       第13人的埋葬者 通常版 32864 自己 0 分、alias=0 → 0 分
 *
 *   而 check-deck 原来只做一件事：把 alias 合并后的号（countCode）交给 lflist 查，
 *   于是 白龙之落胤 被按阿不思的 1 分算。
 *
 * 改法
 *   同名合计（最多 3 张）继续用 countCode —— 官方「视为同一张卡」规则不动；
 *   交给 lflist 查分/查限的卡号改成：自己号有分就用自己号，否则退回 countCode。
 *
 * 用法（幂等，可反复执行）
 *   node tools/apply-patches.cjs
 *   pm2 restart srvpro2_siro:50010
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 原始（上游）
const FROM = 'allCardCodes.push(countCode);';
// 之前那版错误的补丁（已打到服务器上，需要被替换掉）
const WRONG = 'allCardCodes.push(code); // 查分/查限按卡自己的号（同名合计仍用 countCode）';
// 正确版本
const TO = [
  '// 查分/查限的卡号：自己号在 lflist 里有分就用自己号，否则退回 countCode（别名/同名卡继承）',
  'let lflistCode = code;',
  'if (lflist) {',
  "    const genesys = lflist.creditLimits && lflist.creditLimits.find((c) => c.identifier === 'genesys');",
  '    const ownCredit = genesys && genesys.entries && genesys.entries.find((e) => e.code === code);',
  '    if (!(ownCredit && ownCredit.credit > 0)) {',
  '        lflistCode = countCode;',
  '    }',
  '}',
  'allCardCodes.push(lflistCode);',
].join('\n        ');

const TARGETS = [
  'src/utility/check-deck.ts',      // 源码：重新构建后依然生效
  'dist/src/utility/check-deck.js', // 编译产物：不构建也能立刻生效
];

const MARK = 'allCardCodes.push(lflistCode);';
let changed = 0;
let already = 0;
let warned = 0;

console.log('== 组卡校验补丁（查分/查限：自己的分优先，没分才按别名继承）==');
for (const rel of TARGETS) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    console.log('  [跳过] ' + rel + ' 不存在');
    continue;
  }
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes(MARK)) {
    console.log('  [已打过] ' + rel);
    already++;
    continue;
  }
  let next = null;
  if (src.includes(FROM)) {
    next = src.split(FROM).join(TO);
  } else if (src.includes(WRONG)) {
    next = src.split(WRONG).join(TO);      // 从旧版错误补丁升级
  }
  if (next === null) {
    console.log('  [警告] ' + rel + ' 里既没有原始行也没有旧补丁，无法安全替换');
    console.log('         上游可能改过这段逻辑，请人工确认');
    warned++;
    continue;
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.writeFileSync(file + '.bak-' + stamp, src);
  fs.writeFileSync(file, next);
  console.log('  [已打补丁] ' + rel + '（备份：' + path.basename(file) + '.bak-' + stamp + '）');
  changed++;
}

if (changed) {
  console.log('== 完成：改了 ' + changed + ' 个文件 ==');
} else if (warned) {
  console.log('== 有文件没能打上（见上面警告）==');
  process.exitCode = 1;
} else {
  console.log('== 组卡校验补丁：无需改动（已经是补丁后的状态）==');
}

// ══════════════════════════════════════════════════════════════
// 第二组补丁：天梯规则
//   ① 取消「需与 3 名不同对手对战」的上榜条件（常量改成 0，保留常量方便回退）
//   ② 投稿资格提示改为「本赛季 · 天梯 150 分」
// ══════════════════════════════════════════════════════════════
const LADDER_TARGETS = [
  'src/feats/ladder/ladder-service.ts',
  'dist/src/feats/ladder/ladder-service.js',
];
const LADDER_PAIRS = [
  ['const MIN_UNIQUE_OPPONENTS = 0;', null],                     // 已经改过（幂等判定用）
  ['const MIN_UNIQUE_OPPONENTS = 3;      // 排行榜最低对手多样性',
   'const MIN_UNIQUE_OPPONENTS = 0;      // 已取消对手多样性要求（改回 3 即可恢复）'],
  ['const MIN_UNIQUE_OPPONENTS = 3; // 排行榜最低对手多样性',
   'const MIN_UNIQUE_OPPONENTS = 0; // 已取消对手多样性要求（改回 3 即可恢复）'],
  ['`对手数: ${rating.uniqueOpponentCount}  (需${MIN_UNIQUE_OPPONENTS}名不同对手方可上榜)`',
   '`对手数: ${rating.uniqueOpponentCount}`'],
  ['（考察期剩余${myRating.probationGames}场 / 对手数${myRating.uniqueOpponentCount}/${MIN_UNIQUE_OPPONENTS}）',
   '（考察期剩余${myRating.probationGames}场）'],
  ['return `首次参战：定级赛 5 场 · 不同对手 0/${MIN_UNIQUE_OPPONENTS}`;',
   "return '首次参战：定级赛 5 场';"],
  ['（考核期 + 3 名不同对手）', '（考核期）'],
  ['📝 你已获得 DIY 投稿资格（积分≥150），联系群主提交卡稿吧！',
   '📝 你已获得【本赛季】DIY 投稿资格（天梯 150 分），联系群主提交卡稿吧！'],
];
let ladderChanged = 0;
console.log('\n== 天梯规则补丁（取消 3 名不同对手 + 投稿资格按赛季）==');
for (const rel of LADDER_TARGETS) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) { console.log('  [跳过] ' + rel + ' 不存在'); continue; }
  const src = fs.readFileSync(file, 'utf8');
  const todo = LADDER_PAIRS.filter(([a, b]) => b && src.includes(a));
  if (!todo.length) {
    const done = src.includes('const MIN_UNIQUE_OPPONENTS = 0;');
    console.log('  [' + (done ? '已打过' : '无需改动') + '] ' + rel);
    continue;
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  let next = src;
  for (const [a, b] of todo) next = next.split(a).join(b);
  fs.writeFileSync(file + '.bak-' + stamp, src);
  fs.writeFileSync(file, next);
  console.log('  [已打补丁] ' + rel + '（' + todo.length + ' 处，备份 ' + path.basename(file) + '.bak-' + stamp + '）');
  ladderChanged++;
}
if (changed || ladderChanged) {
  console.log('\n== 一共改了 ' + (changed + ladderChanged) + ' 个文件 ==');
  console.log('   下一步：pm2 restart srvpro2_siro:50010');
}

// ══════════════════════════════════════════════════════════════
// 第三组补丁：随机匹配房（M#）规则
//   ① 房主不能踢人（没准备的一方交给超时机制自动请出）
//   ② config.yaml 里的准备倒计时 20 → 30 秒
// ══════════════════════════════════════════════════════════════
const KICK_MARK = '随机匹配房间不能踢人';
const KICK_GUARD_JS = [
  '        // 随机匹配房（M#）不允许房主踢人：没准备的一方交给超时机制自动请出',
  '        if (this.randomType || /^M#/.test(this.name || \'\')) {',
  "            await this.sendChat('随机匹配房间不能踢人：没准备的一方会在倒计时结束后被系统自动请出。');",
  '            return;',
  '        }',
].join('\n');
const KICK_GUARD_TS = [
  '    // 随机匹配房（M#）不允许房主踢人：没准备的一方交给超时机制自动请出',
  "    if (this.randomType || /^M#/.test(this.name || '')) {",
  "      await this.sendChat('随机匹配房间不能踢人：没准备的一方会在倒计时结束后被系统自动请出。');",
  '      return;',
  '    }',
].join('\n');

const KICK_TARGETS = [
  {
    rel: 'dist/src/room/room.js',
    from: "    async onKick(client, msg) {\n        // 只有 host 可以踢人\n        if (!client.isHost) {\n            return;\n        }\n        // 不能踢自己\n        if (client.pos === msg.pos) {\n            return;\n        }",
    guard: KICK_GUARD_JS,
  },
  {
    rel: 'src/room/room.ts',
    from: "  private async onKick(client: Client, msg: YGOProCtosKick) {\n    // 只有 host 可以踢人\n    if (!client.isHost) {\n      return;\n    }\n\n    // 不能踢自己\n    if (client.pos === msg.pos) {\n      return;\n    }\n",
    guard: KICK_GUARD_TS,
  },
];
let kickChanged = 0;
console.log('\n== 随机房规则补丁（房主不能踢人 + 准备倒计时 30 秒）==');
for (const t of KICK_TARGETS) {
  const file = path.join(ROOT, t.rel);
  if (!fs.existsSync(file)) { console.log('  [跳过] ' + t.rel + ' 不存在'); continue; }
  let s = fs.readFileSync(file, 'utf8');
  if (s.includes(KICK_MARK)) { console.log('  [已打过] ' + t.rel); continue; }
  if (!s.includes(t.from)) {
    console.log('  [警告] ' + t.rel + ' 没找到目标代码（上游可能改过），请人工确认');
    continue;
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.writeFileSync(file + '.bak-' + stamp, s);
  fs.writeFileSync(file, s.replace(t.from, t.from + '\n' + t.guard + '\n'));
  console.log('  [已打补丁] ' + t.rel + '（备份 ' + path.basename(file) + '.bak-' + stamp + '）');
  kickChanged++;
}

// config.yaml：准备倒计时 30 秒
const cfgFile = path.join(ROOT, 'config.yaml');
if (fs.existsSync(cfgFile)) {
  const cfg = fs.readFileSync(cfgFile, 'utf8');
  if (/^randomDuelReadyTime:\s*30\s*$/m.test(cfg)) {
    console.log('  [已打过] config.yaml（倒计时已是 30 秒）');
  } else if (/^randomDuelReadyTime:\s*20\s*$/m.test(cfg)) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    fs.writeFileSync(cfgFile + '.bak-' + stamp, cfg);
    fs.writeFileSync(cfgFile, cfg.replace(/^randomDuelReadyTime:\s*20\s*$/m, 'randomDuelReadyTime: 30'));
    console.log('  [已打补丁] config.yaml：randomDuelReadyTime 20 → 30 秒');
    kickChanged++;
  } else {
    console.log('  [警告] config.yaml 里没找到 randomDuelReadyTime: 20，请人工确认');
  }
}

if (kickChanged) {
  console.log('\n== 随机房规则：改了 ' + kickChanged + ' 个文件 ==');
  console.log('   下一步：pm2 restart srvpro2_siro:50010');
}

// ══════════════════════════════════════════════════════════════
// 第四组补丁：满人后「双方都没准备」→ 倒计时结束解散房间
//   （原逻辑只处理“恰好一人没准备”，两人都不准备时什么都不做）
// ══════════════════════════════════════════════════════════════
const DISSOLVE_MARK = '双方都未准备将解散房间';
const WFP_JS = 'dist/src/feats/wait-for-player-provider.js';
const WFP_TS = 'src/feats/wait-for-player-provider.ts';

const DISSOLVE_JS_METHOD = [
'    // 满人且「所有人都没准备」→ 倒计时后解散房间（原逻辑只处理“恰好一人没准备”）',
'    async tickAllUnreadyDissolve(room, nowMs, timeoutMs) {',
'        if (timeoutMs <= 0) {',
'            room.waitForAllUnreadyDeadlineMs = undefined;',
'            return false;',
'        }',
'        const players = room.playingPlayers;',
'        const required = room.randomDuelMaxPlayer || room.players.length;',
'        const unready = players.filter((player) => !player.deck);',
'        const allUnready = players.length >= required && unready.length > 0 && unready.length === players.length;',
'        if (!allUnready) {',
'            room.waitForAllUnreadyDeadlineMs = undefined;',
'            room.waitForAllUnreadyWarnRemain = undefined;',
'            return false;',
'        }',
'        if (!room.waitForAllUnreadyDeadlineMs) {',
'            room.waitForAllUnreadyDeadlineMs = nowMs + timeoutMs;',
'            const seconds = Math.round(timeoutMs / 1000);',
'            await room.sendChat(`本局 ${seconds} 秒后开始：请双方准备，${seconds} 秒内双方都未准备将解散房间。`, ChatColor.LIGHTBLUE);',
'            return true;',
'        }',
'        const remainSeconds = Math.ceil((room.waitForAllUnreadyDeadlineMs - nowMs) / 1000);',
'        if (remainSeconds > 0) {',
'            if (remainSeconds % 5 === 0 && room.waitForAllUnreadyWarnRemain !== remainSeconds) {',
'                room.waitForAllUnreadyWarnRemain = remainSeconds;',
'                await room.sendChat(`还剩 ${remainSeconds} 秒：双方都未准备将解散房间。`, remainSeconds <= 9 ? ChatColor.RED : ChatColor.LIGHTBLUE);',
'            }',
'            return true;',
'        }',
"        await room.sendChat('双方均未准备，房间已解散。', ChatColor.RED);",
'        room.waitForAllUnreadyDeadlineMs = undefined;',
'        room.waitForAllUnreadyWarnRemain = undefined;',
'        for (const player of players.slice()) {',
'            try {',
'                player.disconnect();',
'            } catch (error) {',
'            }',
'        }',
'        return true;',
'    }',
''].join('\n');

const DISSOLVE_JS_CALL = [
'        // 满人 + 双方都没准备 → 走解散流程',
'        if (await this.tickAllUnreadyDissolve(room, nowMs, runtime.options.readyTimeoutMs)) {',
'            return;',
'        }',
''].join('\n');

const DISSOLVE_TS_METHOD = [
'  // 满人且「所有人都没准备」→ 倒计时后解散房间（原逻辑只处理“恰好一人没准备”）',
'  private async tickAllUnreadyDissolve(',
'    room: Room,',
'    nowMs: number,',
'    timeoutMs: number,',
'  ): Promise<boolean> {',
'    if (timeoutMs <= 0) {',
'      room.waitForAllUnreadyDeadlineMs = undefined;',
'      return false;',
'    }',
'    const players = room.playingPlayers;',
'    const required = room.randomDuelMaxPlayer || room.players.length;',
'    const unready = players.filter((player) => !player.deck);',
'    const allUnready =',
'      players.length >= required && unready.length > 0 && unready.length === players.length;',
'    if (!allUnready) {',
'      room.waitForAllUnreadyDeadlineMs = undefined;',
'      room.waitForAllUnreadyWarnRemain = undefined;',
'      return false;',
'    }',
'    if (!room.waitForAllUnreadyDeadlineMs) {',
'      room.waitForAllUnreadyDeadlineMs = nowMs + timeoutMs;',
'      const seconds = Math.round(timeoutMs / 1000);',
'      await room.sendChat(',
'        `本局 ${seconds} 秒后开始：请双方准备，${seconds} 秒内双方都未准备将解散房间。`,',
'        ChatColor.LIGHTBLUE,',
'      );',
'      return true;',
'    }',
'    const remainSeconds = Math.ceil(',
'      (room.waitForAllUnreadyDeadlineMs - nowMs) / 1000,',
'    );',
'    if (remainSeconds > 0) {',
'      if (',
'        remainSeconds % 5 === 0 &&',
'        room.waitForAllUnreadyWarnRemain !== remainSeconds',
'      ) {',
'        room.waitForAllUnreadyWarnRemain = remainSeconds;',
'        await room.sendChat(',
'          `还剩 ${remainSeconds} 秒：双方都未准备将解散房间。`,',
'          remainSeconds <= 9 ? ChatColor.RED : ChatColor.LIGHTBLUE,',
'        );',
'      }',
'      return true;',
'    }',
"    await room.sendChat('双方均未准备，房间已解散。', ChatColor.RED);",
'    room.waitForAllUnreadyDeadlineMs = undefined;',
'    room.waitForAllUnreadyWarnRemain = undefined;',
'    for (const player of players.slice()) {',
'      try {',
'        player.disconnect();',
'      } catch (error) {',
'        void error;',
'      }',
'    }',
'    return true;',
'  }',
''].join('\n');

const DISSOLVE_TS_CALL = [
'    // 满人 + 双方都没准备 → 走解散流程',
'    if (',
'      await this.tickAllUnreadyDissolve(',
'        room,',
'        nowMs,',
'        runtime.options.readyTimeoutMs,',
'      )',
'    ) {',
'      return;',
'    }',
''].join('\n');

const DISSOLVE_TS_DECL_FROM = '    waitForPlayerHangWarnElapsed?: number;';
const DISSOLVE_TS_DECL_TO = [
'    waitForPlayerHangWarnElapsed?: number;',
'    waitForAllUnreadyDeadlineMs?: number;',
'    waitForAllUnreadyWarnRemain?: number;',
].join('\n');

function applyDissolve(rel, anchorMethod, method, callAnchor, call, declFrom, declTo) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) { console.log('  [跳过] ' + rel + ' 不存在'); return 0; }
  let s = fs.readFileSync(file, 'utf8');
  if (s.includes(DISSOLVE_MARK)) { console.log('  [已打过] ' + rel); return 0; }
  if (!s.includes(anchorMethod) || !s.includes(callAnchor)) {
    console.log('  [警告] ' + rel + ' 找不到锚点，请人工确认');
    return 0;
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.writeFileSync(file + '.bak-' + stamp, s);
  s = s.replace(anchorMethod, method + anchorMethod);
  s = s.replace(callAnchor, call + callAnchor);
  if (declFrom && declTo && s.includes(declFrom)) s = s.replace(declFrom, declTo);
  fs.writeFileSync(file, s);
  console.log('  [已打补丁] ' + rel + '（备份 .bak-' + stamp + '）');
  return 1;
}

console.log('\n== 随机房「双方都没准备解散房间」补丁 ==');
let dissolveChanged = 0;
dissolveChanged += applyDissolve(
  WFP_JS,
  '    async tickReadyTimeout(runtime, room, nowMs) {', DISSOLVE_JS_METHOD,
  '        const target = this.getReadyTimeoutTarget(room);', DISSOLVE_JS_CALL,
);
dissolveChanged += applyDissolve(
  WFP_TS,
  '  private async tickReadyTimeout(', DISSOLVE_TS_METHOD,
  '    const target = this.getReadyTimeoutTarget(room);', DISSOLVE_TS_CALL,
  DISSOLVE_TS_DECL_FROM, DISSOLVE_TS_DECL_TO,
);
if (dissolveChanged) {
  console.log('\n== 改了 ' + dissolveChanged + ' 个文件 ==');
  console.log('   下一步：pm2 restart srvpro2_siro:50010');
}

// ══════════════════════════════════════════════════════════════
// 第五组补丁：D# 比赛房改成单局（BO1）
//   registerRoomMode('D') 原本设 winMatchCount=2（三局两胜），改成 1（单局）。
//   注意不能动 (M|MATCH) 那条，它同样是 2。
// ══════════════════════════════════════════════════════════════
const D_TARGETS = [
  {
    rel: 'dist/src/room/default-hostinfo-provder.js',
    re: /(\.registerRoomMode\('D', \(\{ hostinfo \}\) => \(\{\s*\n\s*mode: setWinMatchCountBits\(hostinfo\.mode, )2(\),)/,
    check: /\.registerRoomMode\('D', \(\{ hostinfo \}\) => \(\{\s*\n\s*mode: setWinMatchCountBits\(hostinfo\.mode, 1\),/,
  },
  {
    rel: 'src/room/default-hostinfo-provder.ts',
    re: /(\.registerRoomMode\('D', \(\{ hostinfo \}\) => \(\{\s*\n\s*mode: setWinMatchCountBits\(hostinfo\.mode, )2(\),)/,
    check: /\.registerRoomMode\('D', \(\{ hostinfo \}\) => \(\{\s*\n\s*mode: setWinMatchCountBits\(hostinfo\.mode, 1\),/,
  },
];
let bo1Changed = 0;
console.log('\n== D# 比赛房改成单局（BO1）补丁 ==');
for (const t of D_TARGETS) {
  const file = path.join(ROOT, t.rel);
  if (!fs.existsSync(file)) { console.log('  [跳过] ' + t.rel + ' 不存在'); continue; }
  const s = fs.readFileSync(file, 'utf8');
  if (t.check.test(s)) { console.log('  [已打过] ' + t.rel); continue; }
  if (!t.re.test(s)) { console.log('  [警告] ' + t.rel + ' 没匹配到 D 模式定义，请人工确认'); continue; }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.writeFileSync(file + '.bak-' + stamp, s);
  fs.writeFileSync(file, s.replace(t.re, '$11$2'));
  console.log('  [已打补丁] ' + t.rel + '（D# → 单局，备份 ' + path.basename(file) + '.bak-' + stamp + '）');
  bo1Changed++;
}
if (bo1Changed) {
  console.log('\n== D# 单局：改了 ' + bo1Changed + ' 个文件 ==');
  console.log('   下一步：pm2 restart srvpro2_siro:50010');
}
