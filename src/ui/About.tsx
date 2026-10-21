import { useEffect, useState } from 'react';

const REPO = 'https://github.com/MrWisz/Pauper-Sim';
/** everything the app keeps in this browser */
const STORAGE_KEYS = ['pauper-sim-setup-v1', 'pauper-sim-extra-cards-v1'];

export const FAN_CONTENT_NOTICE =
  'Pauper Sim is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.';

/** Footer for the setup screen: the Wizards notice and the About & privacy panel. */
export function AboutFooter() {
  const [open, setOpen] = useState(false);
  return (
    <footer className="about-footer">
      <p>{FAN_CONTENT_NOTICE}</p>
      <button className="link-btn" onClick={() => setOpen(true)}>
        About &amp; privacy
      </button>
      {open && <AboutPanel onClose={() => setOpen(false)} />}
    </footer>
  );
}

function AboutPanel({ onClose }: { onClose: () => void }) {
  const [cleared, setCleared] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const clearData = () => {
    try {
      for (const k of STORAGE_KEYS) localStorage.removeItem(k);
    } catch {
      /* storage unavailable */
    }
    setConfirming(false);
    setCleared(true);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal about" role="dialog" aria-modal="true" aria-labelledby="about-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">
          <h2 id="about-title">About &amp; privacy</h2>
          <button className="min-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <h3>About</h3>
        <p>
          Pauper Sim is a free, fan-made practice tool for playing Pauper decks against a computer opponent. It has no ads, accounts or
          paid features. The source code is on <a href={REPO} target="_blank" rel="noopener noreferrer">GitHub</a>.
        </p>

        <h3>Privacy</h3>
        <ul>
          <li>
            <strong>No accounts, cookies, analytics or ads.</strong> Games run entirely in your browser; nothing you do in a game is sent
            anywhere.
          </li>
          <li>
            <strong>Saved in your browser:</strong> your last setup (deck lists, match options) and a cache of card data looked up from
            Scryfall. It stays on this device and is only used to run the app. You can clear it below.
          </li>
          <li>
            <strong>Scryfall:</strong> card images load from Scryfall, and importing a card the app doesn't include sends that card's name to
            Scryfall's API. Like any website, Scryfall receives your IP address and browser details with those requests. See{' '}
            <a href="https://scryfall.com/docs/privacy" target="_blank" rel="noopener noreferrer">
              Scryfall's privacy policy
            </a>
            .
          </li>
          <li>
            <strong>Hosting:</strong> the site is hosted on Netlify, which keeps standard server logs (such as IP addresses) to deliver and
            protect the site. See{' '}
            <a href="https://www.netlify.com/privacy/" target="_blank" rel="noopener noreferrer">
              Netlify's privacy policy
            </a>
            .
          </li>
          <li>
            Questions? Open an issue on{' '}
            <a href={`${REPO}/issues`} target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
            .
          </li>
        </ul>
        <div className="about-clear">
          {cleared ? (
            <span className="about-done">Saved data cleared. Reload the page to start fresh.</span>
          ) : confirming ? (
            <>
              <span>Remove your saved decklists and card cache from this browser?</span>
              <button className="btn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button className="btn primary" onClick={clearData}>
                Clear
              </button>
            </>
          ) : (
            <button className="btn" onClick={() => setConfirming(true)}>
              Clear saved data
            </button>
          )}
        </div>

        <h3>Card data &amp; images</h3>
        <p>
          Card text and images come from{' '}
          <a href="https://scryfall.com" target="_blank" rel="noopener noreferrer">
            Scryfall
          </a>
          . Pauper Sim isn't produced by or affiliated with Scryfall.
        </p>
        <p className="about-legal">{FAN_CONTENT_NOTICE}</p>
      </div>
    </div>
  );
}
