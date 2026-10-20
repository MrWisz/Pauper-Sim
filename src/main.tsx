import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './ui/styles.css';
import './ui/mobile.css';

// Netlify-hosted builds get a "Powered by Netlify" badge pinned to the bottom of the page;
// mark the page so the layout can keep the hand clear of it (see --host-inset in mobile.css)
if (location.hostname.endsWith('.netlify.app')) document.documentElement.classList.add('host-badge');

createRoot(document.getElementById('root')!).render(<App />);
