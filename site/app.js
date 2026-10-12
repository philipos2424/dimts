// Waitlist forms and the hero's one load sequence. No dependencies.
const WAITLIST_URL = 'https://dimts.vercel.app/api/waitlist';
const APP_URL = 'https://dimts.vercel.app/';

// Start the pad's sequence once it is on screen; reduced motion shows the end state.
const pad = document.querySelector('.pad.animate');
if (pad) {
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still || !('IntersectionObserver' in window)) pad.classList.remove('animate');
  else {
    const seen = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { pad.classList.add('run'); seen.disconnect(); }
    }, { threshold: 0.35 });
    seen.observe(pad);
  }
}

const params = new URLSearchParams(location.search);
const campaign = params.get('utm_source') || params.get('ref');
const country = (navigator.language || '').split('-')[1] || '';

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

for (const form of document.querySelectorAll('form[data-waitlist]')) {
  const error = form.querySelector('.error');
  const button = form.querySelector('button[type=submit]');
  const showError = message => { error.textContent = message; error.hidden = false; };

  form.addEventListener('submit', async event => {
    event.preventDefault();
    error.hidden = true;
    const data = new FormData(form);
    const email = String(data.get('email') || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      showError('Enter an email address like name@company.com.');
      form.querySelector('input[type=email]').focus();
      return;
    }
    button.disabled = true;
    button.textContent = 'Joining…';
    try {
      const response = await fetch(WAITLIST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          platform: data.get('platform') || null,
          company: data.get('company') || '',
          country,
          source: [form.dataset.source, campaign].filter(Boolean).join(':'),
        }),
      });
      if (response.status === 429) throw new Error('Too many sign-ups from this connection. Try again in an hour.');
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || 'The waitlist did not save your email. Try again in a minute.');
      }
      const done = document.createElement('div');
      done.className = 'joined';
      done.setAttribute('role', 'status');
      done.innerHTML = `<p><strong>You're on the list.</strong> We'll email ${escapeHtml(email)} once, the day the apps are in the stores.</p>
        <p>Until then, Dimts works in your browser: <a href="${APP_URL}">start your 21-day trial</a>.</p>`;
      form.replaceWith(done);
      done.tabIndex = -1;
      done.focus();
    } catch (err) {
      showError(err instanceof TypeError ? 'No connection to Dimts. Check your internet and try again.' : err.message);
      button.disabled = false;
      button.textContent = 'Join the waitlist';
    }
  });
}
