import { createApp } from 'vue';
import App from './App.vue';
import SettingsApp from './SettingsApp.vue';
import QuickPanel from './components/QuickPanel.vue';
import './styles/tokens.css';
import './styles/base.css';
import './styles/dock.css';
import './styles/quick.css';

const isSettings = window.location.hash === '#settings';
const isQuick = window.location.hash === '#quick';
if (isSettings) document.documentElement.classList.add('settings-mode');
if (isQuick) document.documentElement.classList.add('quick-mode');
createApp(isQuick ? QuickPanel : (isSettings ? SettingsApp : App)).mount('#app');
