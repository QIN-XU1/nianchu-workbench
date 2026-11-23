import { useEffect, useState } from 'react';
import { Shell } from './shell/Shell';
import { initAppearance } from './appearance';
import './app.css';

/**
 * 外观统一由 appearance 模块管理（设置场景也能改）。
 * 这里只负责首次把属性刷到 html 上。
 */
export default function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    initAppearance();
    setReady(true);
  }, []);

  if (!ready) return null;
  return <Shell />;
}
