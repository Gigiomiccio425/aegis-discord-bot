import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { applicaTemaIniziale, TemaProvider } from './tema.js';
import './index.css';

// Prima di disegnare qualunque cosa: altrimenti chi usa un tema chiaro vede
// un lampo del tema scuro a ogni caricamento.
applicaTemaIniziale();

const root = document.getElementById('root');
if (!root) throw new Error('elemento #root non trovato');

createRoot(root).render(
  <StrictMode>
    <TemaProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </TemaProvider>
  </StrictMode>,
);
