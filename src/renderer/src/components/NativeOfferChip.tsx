import { t } from '../i18n'
import { openNativeOffer, useNativeOffer } from '../native-offer'

/** Title-bar entry for the stable native offer. Lazy: nothing of the offer
 * (state hook, handover collection) belongs in the eager renderer entry. */
export default function NativeOfferChip(): React.JSX.Element | null {
  const offer = useNativeOffer()
  if (!offer.available || offer.channel !== 'stable') return null
  return (
    <button
      type="button"
      className="pill ghost small no-drag update-chip"
      title={t('app.nativeOffer.chipTitle')}
      onClick={openNativeOffer}
    >
      {t('app.nativeOffer.chip')}
    </button>
  )
}
