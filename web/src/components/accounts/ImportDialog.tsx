import { accountApi } from '../../lib/api';
import AccountImportDialog from './AccountImportDialog';

export default function ImportDialog({ open, onClose, onImport }: {
  open: boolean; onClose: () => void; onImport: () => void;
}) {
  return open ? <AccountImportDialog source="file" onClose={onClose} onImport={accountApi.import} onImported={onImport} /> : null;
}
