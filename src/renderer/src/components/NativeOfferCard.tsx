import { t } from '../i18n'
import { openNativeOffer, useNativeOffer } from '../native-offer'

/** The quiet entry for the native app (D-04): settings and What's New. Renders
 * nothing unless the build enables the offer and a native release is available,
 * and "Not now" keeps the singer on this app, with the offer gone until a newer
 * native release (or the stable one) arrives. */
export default function NativeOfferCard(): React.JSX.Element | null {
  const offer = useNativeOffer()
  if (!offer.available) return null
  return (
    <section className="native-offer-card" aria-labelledby="native-offer-heading">
      <h3 id="native-offer-heading">{t(offer.channel === 'beta' ? 'app.nativeOffer.betaTitle' : 'app.nativeOffer.stableTitle')}</h3>
      <p className="settings-hint">{t('app.nativeOffer.body', { version: offer.version })}</p>
      <div className="modal-actions">
        <button type="button" className="pill ghost" onClick={() => void window.singz.dismissNativeOffer()}>
          {t('app.nativeOffer.dismiss')}
        </button>
        <button type="button" className="pill primary" onClick={openNativeOffer}>
          {t('app.nativeOffer.open')}
        </button>
      </div>
    </section>
  )
}
