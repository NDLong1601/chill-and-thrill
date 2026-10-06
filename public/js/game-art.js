'use strict';

// Only maps public card values to artwork; never reads or infers hidden cards.
(function gameArtwork() {
  const suits = { S: 'S', H: 'H', D: 'D', C: 'C', spades: 'S', hearts: 'H', diamonds: 'D', clubs: 'C' };
  const symbols = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const ranks = new Set(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);
  const faceRanks = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  function cardInfo(card) {
    if (!card) return null;
    const suit = suits[card.suit], rank = String(card.rank ?? faceRanks[card.value] ?? card.value ?? '');
    return suit && ranks.has(rank) ? { id: `${rank}${suit}`, label: `${rank}${symbols[suit]}` } : null;
  }
  function cardMarkup(card) {
    const info = cardInfo(card);
    return info ? `<img class="card-art" src="/assets/game/cards/${info.id}.webp" alt="" draggable="false"><span class="art-card-label">${info.label}</span>` : '';
  }
  function paintCard(element, card) {
    const info = cardInfo(card);
    if (!info) return element;
    element.classList.add('has-card-art'); element.dataset.card = info.id;
    element.setAttribute('aria-label', info.label); element.innerHTML = cardMarkup(card);
    return element;
  }
  function backMarkup() {
    return '<img class="card-art" src="/assets/game/cards/back.webp" alt="" draggable="false"><span class="art-card-label">Mặt sau lá bài</span>';
  }
  function icon(name, className = 'resource-icon') {
    return ['coin', 'gem', 'chip', 'logo'].includes(name) ? `<img class="${escape(className)}" src="/assets/game/${name}.webp" alt="" draggable="false">` : '';
  }
  window.GameArt = { cardInfo, cardMarkup, paintCard, backMarkup, icon };
  document.addEventListener('error', event => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('card-art')) return;
    if (!img.dataset.artRetry && img.src.includes('.webp')) {
      img.dataset.artRetry = 'png'; img.src = img.src.replace('.webp', '.png'); return;
    }
    img.hidden = true; img.parentElement.classList.add('art-fallback');
  }, true);
})();
