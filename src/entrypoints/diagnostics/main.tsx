import { createRoot } from 'react-dom/client';
import '../../ui/styles.css';
import { Diagnostics } from '../../ui/Diagnostics';

createRoot(document.getElementById('root')!).render(<Diagnostics />);
