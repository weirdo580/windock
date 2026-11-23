import { createApp } from 'vue';
import App from './App.vue';
import SettingsApp from './SettingsApp.vue';
import './styles/tokens.css';
import './styles/base.css';
import './styles/dock.css';

const isSettings = window.location.hash === '#settings';
if (isSettings) document.documentElement.classList.add('settings-mode');
createApp(isSettings ? SettingsApp : App).mount('#app');
