import { useEffect, useState } from 'react';
import {
  getScheme, getDensity, setScheme, setDensity, subscribeAppearance,
  type Scheme, type Density,
} from '../appearance';

/**
 * 设置场景 —— 目前只做可交互的外观控制，用来验证：
 *   · 明暗两套令牌真的在切换（不是只有一组）
 *   · 密度只缩放间距、不改字号
 * 后续阶段（S5/S6）这里会接模型网关、快捷键、诊断。
 */
export default function Settings() {
  const [, force] = useState(0);

  useEffect(() => subscribeAppearance(() => force((n) => n + 1)), []);

  const scheme = getScheme();
  const density = getDensity();

  return (
    <div className="vp-page">
      <section className="vp-sec">
        <h2 className="vp-sec__h">外观</h2>
        <p className="vp-sec__p">
          切换后立即生效，并写进 localStorage；刷新保持。也可以用 URL 参数
          <code>?scheme=dark&amp;density=cozy</code> 直接打开某个外观。
        </p>

        <div className="vp-form">
          <div className="vp-form__row">
            <div className="vp-form__label">
              <strong>主题</strong>
              <span>明暗两套语义色，同一套令牌名</span>
            </div>
            <div className="vp-seg" role="radiogroup" aria-label="主题">
              {(['light', 'dark'] as Scheme[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={scheme === v}
                  className="vp-seg__btn"
                  onClick={() => setScheme(v)}
                >
                  {v === 'light' ? '亮色' : '暗色'}
                </button>
              ))}
            </div>
          </div>

          <div className="vp-form__row">
            <div className="vp-form__label">
              <strong>密度</strong>
              <span>只缩放间距，不改字号</span>
            </div>
            <div className="vp-seg" role="radiogroup" aria-label="密度">
              {(['compact', 'cozy'] as Density[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={density === v}
                  className="vp-seg__btn"
                  onClick={() => setDensity(v)}
                >
                  {v === 'compact' ? '紧凑' : '宽松'}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="vp-sec">
        <h2 className="vp-sec__h">当前取值</h2>
        <div className="vp-kv">
          <div className="vp-kv__row"><span>data-color-scheme</span><code>{scheme}</code></div>
          <div className="vp-kv__row"><span>data-density</span><code>{density}</code></div>
          <div className="vp-kv__row"><span>外观来源</span><code>{new URLSearchParams(location.search).get('scheme') ? 'URL 参数' : '本地存储'}</code></div>
        </div>
      </section>

      <section className="vp-sec">
        <h2 className="vp-sec__h">未接后端</h2>
        <p className="vp-sec__p">
          模型网关、快捷键、诊断在后续阶段接入。现在侧栏底部那个灰点是「未接后端」的意思 ——
          它不会假装成正常状态。
        </p>
      </section>
    </div>
  );
}
