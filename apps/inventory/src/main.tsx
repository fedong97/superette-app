import { createRoot } from 'react-dom/client';
import { App } from './App';
import { init } from './state';
import './styles.css';

void init();
createRoot(document.getElementById('root')!).render(<App />);
