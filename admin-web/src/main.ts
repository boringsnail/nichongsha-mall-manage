import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';

// 样式加载顺序很重要：EP 基础 → EP 深色变量 → 字体 → 自有令牌 → EP 主题重写。
// 顺序反了会被 Element Plus 的默认样式盖掉。
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/element.css';
// 手机端覆盖层必须最后加载，否则被 element.css 的桌面规则盖回去
import './styles/mobile.css';

import { initNativeShell } from './native/shell';
import App from './App.vue';
import router from './router';

const app = createApp(App);
app.use(createPinia());
app.use(router);
// 必须显式指定中文语言包，否则分页会显示「Total 8」这类英文
app.use(ElementPlus, { locale: zhCn });
app.mount('#app');
// App 内：按当前主题初始化系统状态栏（浏览器里是空操作）
initNativeShell();
