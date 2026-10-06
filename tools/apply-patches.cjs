#!/usr/bin/env node
/**
 * 本地补丁：组卡校验里「查分/查限」改用卡自己的卡号
 * ─────────────────────────────────────────────────────────────
 * 背景
 *   官方有一批「规则上视为同一张卡」的卡（置换融合≈融合、白龙之落胤≈阿不思的落胤 …），
 *   它们在 CDB 里的 alias 指向原卡——这是**正确**的，用于「同名合计最多 3 张」。
 *   但 check-deck 把 alias 合并后的卡号也拿去查 lflist（分值/限制），
 *   于是 白龙之落胤(20 分) 被按 阿不思的落胤(1 分) 处理。
 *
 * 改法
 *   同名合计继续用 countCode（官方规则，保持不动）；
 *   传给 lflist 的卡号改成卡自己的 code。
 *
 * 用法（幂等，可反复执行）
 *   node tools/apply-patches.cjs
 *   pm2 restart srvpro2_siro:50010
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FROM = 'allCardCodes.push(countCode);';
const TO = 'allCardCodes.push(code); // 查分/查限按卡自己的号（同名合计仍用 countCode）';

const TARGETS = [
  'src/utility/check-deck.ts',      // 源码：重新构建后依然生效
  'dist/src/utility/check-deck.js', // 编译产物：不构建也能立刻生效
];

let changed = 0;
let already = 0;
let warned = 0;

console.log('== 组卡校验补丁（查分/查限按卡自己的卡号）==');
for (const rel of TARGETS) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    console.log('  [跳过] ' + rel + ' 不存在');
    continue;
  }
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes(TO)) {
    console.log('  [已打过] ' + rel);
    already++;
    continue;
  }
  if (!src.includes(FROM)) {
    console.log('  [警告] ' + rel + ' 里没找到待改的行：' + FROM);
    console.log('         上游可能改过这段逻辑，请人工确认后再处理');
    warned++;
    continue;
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.writeFileSync(file + '.bak-' + stamp, src);
  fs.writeFileSync(file, src.split(FROM).join(TO));
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
