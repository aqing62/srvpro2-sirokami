const DELIMITER_CLASS = '[+ \uFF0B]';
const NO_DELIMITER_CLASS = '[^+ \uFF0B]';

function escapeRegex(value: string) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

export function getDeckNameExactCandidates(playerName: string) {
  return [playerName, `${playerName}.ydk`, `${playerName}.ydk.ydk`];
}

export function getDeckNameRegexCandidates(playerName: string) {
  const escapedPlayerName = escapeRegex(playerName);
  return {
    firstPlayerRegex: `^${escapedPlayerName}${DELIMITER_CLASS}.+(\\.ydk){0,2}$`,
    secondPlayerRegex: `^${NO_DELIMITER_CLASS}+${DELIMITER_CLASS}${escapedPlayerName}(\\.ydk){0,2}$`,
  };
}
