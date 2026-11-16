import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { EXPORT_SCRIPT_ID } from '@agent-canvas/shared';
import { exportDocumentTitle, parseExportData } from './data';
import { Viewer, ViewerMessage } from './Viewer';
import '../styles.css';
import './viewer.css';

// The exported file's entry: the data is the text of the JSON block the server filled in (never markup), parsed once.
const parsed = parseExportData(document.getElementById(EXPORT_SCRIPT_ID)?.textContent ?? null);
if (parsed.ok) document.title = exportDocumentTitle(parsed.bundle);

const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      {parsed.ok ? <Viewer bundle={parsed.bundle} /> : <ViewerMessage message={parsed.message} />}
    </StrictMode>,
  );
}
