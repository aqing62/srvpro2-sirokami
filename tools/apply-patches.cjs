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
  console.log('   下一步：pm2 restart srvpro2_siro:50010');
} else if (warned) {
  console.log('== 没改动任何文件（见上面警告）==');
  process.exitCode = 1;
} else {
  console.log('== 无需改动（已经是补丁后的状态，共 ' + already + ' 个文件）==');
}
