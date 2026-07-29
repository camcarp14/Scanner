import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
// After styles.css, not before, and deliberately not an @import: the palette
// blocks and the :root defaults they override have identical specificity, so
// source order is what decides. An @import would have to sit above every rule
// in styles.css, which is exactly backwards.
import './design/themes.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
