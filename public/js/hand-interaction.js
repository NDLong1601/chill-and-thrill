'use strict';

// Local selection only. A gesture never submits cards or changes a room revision.
(function handInteraction() {
  const hands = new WeakMap();
  function attach(target) {
    const data = { config: null, gesture: null, suppressClickUntil: 0 };
    hands.set(target, data);
    const cardAt = event => document.elementFromPoint(event.clientX, event.clientY)?.closest('button[data-card-id]');
    function paint() {
      target.querySelectorAll('button[data-card-id]').forEach(button => {
        const checked = data.config.selected.has(button.dataset.cardId);
        button.classList.toggle('selected', checked); button.setAttribute('aria-pressed', String(checked));
      });
      const label = target.closest('.hand')?.querySelector('.hand-selection');
      if (label) label.textContent = data.config.selected.size ? `${data.config.selected.size} lá chọn` : 'Chạm / vuốt chọn bài';
    }
    function change(ids, choose) {
      const next = new Set(data.config.selected);
      for (const id of ids) choose ? next.add(id) : next.delete(id);
      data.config.selected = next; paint(); data.config.onChange(next);
    }
    target.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary) return;
      const button = event.target.closest('button[data-card-id]');
      if (!button || button.disabled) return;
      target.getAnimations({ subtree: true }).forEach(animation => { try { animation.finish(); } catch { animation.cancel(); } });
      const id = button.dataset.cardId, buttons = [...target.querySelectorAll('button[data-card-id]')];
      data.gesture = { pointerId: event.pointerId, last: buttons.indexOf(button), visited: new Set([id]), choose: !data.config.selected.has(id), before: new Set(data.config.selected) };
      data.suppressClickUntil = performance.now() + 800;
      target.setPointerCapture(event.pointerId); change([id], data.gesture.choose);
    });
    target.addEventListener('pointermove', event => {
      const gesture = data.gesture; if (!gesture || event.pointerId !== gesture.pointerId) return;
      const button = cardAt(event); if (!button || !target.contains(button)) return;
      const buttons = [...target.querySelectorAll('button[data-card-id]')], index = buttons.indexOf(button), ids = [];
      // Include every crossed card even when a touch moves several cards in one frame.
      for (let i = Math.min(index, gesture.last); i <= Math.max(index, gesture.last); i++) {
        const item = buttons[i], id = item.dataset.cardId;
        if (!item.disabled && !gesture.visited.has(id)) { ids.push(id); gesture.visited.add(id); }
      }
      gesture.last = index; if (ids.length) change(ids, gesture.choose);
    });
    function finish(event, cancelled = false) {
      if (!data.gesture || event.pointerId !== data.gesture.pointerId) return;
      const before = data.gesture.before; data.gesture = null; data.suppressClickUntil = performance.now() + 800;
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      if (cancelled) { data.config.selected = before; paint(); data.config.onChange(before); }
    }
    target.addEventListener('pointerup', event => finish(event));
    target.addEventListener('pointercancel', event => finish(event, true));
    target.addEventListener('click', event => {
      const button = event.target.closest('button[data-card-id]');
      if (!button || button.disabled || (event.detail !== 0 && performance.now() < data.suppressClickUntil)) return;
      const id = button.dataset.cardId; change([id], !data.config.selected.has(id));
    });
    data.paint = paint; return data;
  }
  function render(config) {
    const data = hands.get(config.target) || attach(config.target);
    if (data.gesture && config.target.hasPointerCapture(data.gesture.pointerId)) config.target.releasePointerCapture(data.gesture.pointerId);
    data.gesture = null; data.config = { ...config, selected: new Set(config.selected) };
    config.target.replaceChildren(...config.cards.map((card, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'tl-card';
      if (['H', 'D'].includes(card.suit)) button.classList.add('red');
      button.dataset.cardId = card.id; button.style.setProperty('--deal-index', index);
      if (config.marked?.(card)) button.classList.add('opening');
      button.disabled = config.disabled?.(card) || false; button.title = config.title?.(card) || '';
      GameArt.paintCard(button, card); return button;
    }));
    data.paint();
  }
  window.HandInteraction = { render };
})();
