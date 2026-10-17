import type { ImportRequest, ImportResult } from '../../types';
import AccountImportDialog from './AccountImportDialog';

export default function PasteImportDialog({ open, onClose, onImport }: {
  open: boolean; onClose: () => void; onImport: (request: ImportRequest) => Promise<ImportResult>;
}) {
  return open ? <AccountImportDialog source="paste" onClose={onClose} onImport={onImport} /> : null;
}
