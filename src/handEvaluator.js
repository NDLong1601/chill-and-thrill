'use strict';

const RANK_NAMES = {
  10: { en: 'Royal Flush', vi: 'Sảnh chúa' },
  9:  { en: 'Straight Flush', vi: 'Thùng phá sảnh' },
  8:  { en: 'Four of a Kind', vi: 'Tứ quý' },
  7:  { en: 'Full House', vi: 'Cù lũ' },
  6:  { en: 'Flush', vi: 'Thùng' },
  5:  { en: 'Straight', vi: 'Sảnh' },
  4:  { en: 'Three of a Kind', vi: 'Bộ ba lá' },
  3:  { en: 'Two Pair', vi: 'Hai đôi' },
  2:  { en: 'One Pair', vi: 'Một đôi' },
  1:  { en: 'High Card', vi: 'Bài cao' },
};

/**
 * Evaluate best 5-card poker hand from hole cards + community cards.
 * Returns { score, rankLevel, name, nameVi, best5 }
 */
function getBestHand(privateCards, communityCards, options = {}) {
  const allCards = [...privateCards, ...communityCards].filter(Boolean);

  if (allCards.length < 5) {
    return evaluatePartial(allCards);
  }

  const combos = getCombinations(allCards, 5);
  let best = { score: -Infinity, rankLevel: 0, name: '', nameVi: '', best5: [] };

  for (const combo of combos) {
    const result = evaluate5(combo);
    if (result.score > best.score) {
      best = { ...result, best5: combo };
    }
  }

  // Specialist #10 "Cơ bắp": Người có thẻ này thắng bất kỳ người nào có cùng hạng bài
  if (options.hasMuscleBonus) {
    best.score = (best.rankLevel + 1) * 16 ** 5 - 1;
    best.nameVi += ' (Cơ bắp 💪)';
  }

  return best;
}

function evaluatePartial(cards) {
  const vals = cards.map(c => c.value).sort((a, b) => b - a);
  const freq = {};
  for (const v of vals) freq[v] = (freq[v] || 0) + 1;
  const top = Math.max(...Object.values(freq), 0);

  if (top >= 2) {
    const groups = Object.entries(freq).sort((a, b) => b[1] - a[1] || Number(b[0]) - Number(a[0]));
    const rank = top >= 4 ? 8 : top === 3 ? 4 : groups.filter(g => g[1] === 2).length > 1 ? 3 : 2;
    const tieVals = groups.flatMap(([v, count]) => Array(count).fill(Number(v)));
    return {
      score: encodeScore(rank, tieVals),
      rankLevel: rank,
      name: RANK_NAMES[rank].en,
      nameVi: RANK_NAMES[rank].vi,
      best5: cards,
    };
  }
  return {
    score: encodeScore(1, vals),
    rankLevel: 1,
    name: RANK_NAMES[1].en,
    nameVi: RANK_NAMES[1].vi,
    best5: cards,
  };
}

function getCombinations(arr, k) {
  const result = [];
  function helper(start, curr) {
    if (curr.length === k) { result.push([...curr]); return; }
    for (let i = start; i <= arr.length - (k - curr.length); i++) {
      curr.push(arr[i]);
      helper(i + 1, curr);
      curr.pop();
    }
  }
  helper(0, []);
  return result;
}

function evaluate5(cards) {
  const vals = cards.map(c => c.value).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);
  const isFlush = new Set(suits).size === 1 && !suits.includes('none');
  const { isStraight, hi } = checkStraight(vals);

  const freq = {};
  for (const v of vals) freq[v] = (freq[v] || 0) + 1;
  const groups = Object.entries(freq)
    .sort((a, b) => b[1] - a[1] || parseInt(b[0]) - parseInt(a[0]));
  const tieVals = groups.flatMap(([v, c]) => Array(c).fill(parseInt(v)));
  const topCount = groups[0][1];

  let rankLevel = 1;
  let scoreVals = vals;

  if (isFlush && isStraight) {
    if (hi === 14) {
      rankLevel = 10;
      scoreVals = [14, 13, 12, 11, 10];
    } else {
      rankLevel = 9;
      scoreVals = [hi];
    }
  } else if (topCount >= 4) {
    rankLevel = 8;
    scoreVals = tieVals;
  } else if (topCount === 3 && groups[1][1] === 2) {
    rankLevel = 7;
    scoreVals = tieVals;
  } else if (isFlush) {
    rankLevel = 6;
    scoreVals = vals;
  } else if (isStraight) {
    rankLevel = 5;
    scoreVals = [hi];
  } else if (topCount === 3) {
    rankLevel = 4;
    scoreVals = tieVals;
  } else if (topCount === 2 && groups[1][1] === 2) {
    rankLevel = 3;
    scoreVals = tieVals;
  } else if (topCount === 2) {
    rankLevel = 2;
    scoreVals = tieVals;
  } else {
    rankLevel = 1;
    scoreVals = vals;
  }

  return {
    score: encodeScore(rankLevel, scoreVals),
    rankLevel,
    name: RANK_NAMES[rankLevel].en,
    nameVi: RANK_NAMES[rankLevel].vi,
  };
}

function checkStraight(sortedVals) {
  const unique = [...new Set(sortedVals)].sort((a, b) => b - a);
  if (unique.length < 5) return { isStraight: false, hi: 0 };

  for (let i = 0; i <= unique.length - 5; i++) {
    if (unique[i] - unique[i + 4] === 4) {
      return { isStraight: true, hi: unique[i] };
    }
  }

  // Ace-low straight: A-2-3-4-5
  if (unique.includes(14) && unique.includes(2) && unique.includes(3) && unique.includes(4) && unique.includes(5)) {
    return { isStraight: true, hi: 5 };
  }

  return { isStraight: false, hi: 0 };
}

function encodeScore(rank, vals) {
  let s = rank;
  for (let i = 0; i < 5; i++) {
    s = s * 16 + (vals[i] || 0);
  }
  return s;
}

/**
 * Check Showdown with Tie rule support (Hòa đúng):
 * players: [{ id, name, chip, handScore, handNameVi, handName }]
 * Sort by chip ascending:
 * For each pair i, i+1: curr.chip <= next.chip.
 * If curr.handScore > next.handScore -> ERROR (vụ cướp thất bại)
 * If curr.handScore === next.handScore -> TIE (hòa đúng, hợp lệ)
 * If curr.handScore < next.handScore -> CORRECT (hợp lệ)
 */
function checkShowdown(players) {
  if (players.some(p => p.chip === null || p.chip === undefined)) {
    return { success: false, reason: 'Không phải tất cả người chơi đều có chip ở vòng cuối!' };
  }

  const byChip = [...players].sort((a, b) => a.chip - b.chip);

  for (let i = 0; i < byChip.length - 1; i++) {
    const curr = byChip[i];
    const next = byChip[i + 1];
    if (curr.handScore > next.handScore) {
      return {
        success: false,
        reason: `Sai thứ tự! ${curr.name} (Chip ${curr.chip}⭐ · ${curr.handNameVi || curr.handName}) mạnh hơn ${next.name} (Chip ${next.chip}⭐ · ${next.handNameVi || next.handName})!`,
      };
    }
  }

  return { success: true, reason: 'Thứ tự bài hoàn hảo! 🔓 Két sắt mở!' };
}

function explainComparison(a, b) {
  if (a.handScore === b.handScore) return 'Hòa đúng: cùng sức mạnh của 5 lá tốt nhất; thứ tự hai chip đều hợp lệ.';
  const stronger = a.handScore > b.handScore ? a : b;
  if (a.rankLevel !== b.rankLevel) return `${stronger.name} mạnh hơn vì có thứ hạng tay bài cao hơn.`;
  if (stronger.hasMuscleBonus) return `${stronger.name} mạnh hơn nhờ chuyên gia Cơ bắp trong cùng thứ hạng.`;
  const values = p => {
    let score = p.handScore % (16 ** 5);
    return Array.from({ length: 5 }, (_, i) => Math.floor(score / (16 ** (4 - i))) % 16);
  };
  const av = values(a), bv = values(b), i = av.findIndex((v, index) => v !== bv[index]);
  const label = v => ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[v] || v);
  return `${stronger.name} mạnh hơn: cùng ${stronger.handNameVi}, giá trị quyết định ${label(av[i])} so với ${label(bv[i])} (so bộ chính trước, rồi các lá phụ).`;
}

module.exports = { getBestHand, checkShowdown, RANK_NAMES, explainComparison };
