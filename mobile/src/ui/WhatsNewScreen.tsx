import React, { useEffect } from 'react'
import { Icon } from '@singz/ui/native/icons'
import { Image, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { RELEASE_VERSION, releaseHighlights } from '../../../src/shared/release-highlights'
import { t, useLocale } from '../i18n'
import { getStoredText, setStoredText } from '../latency'
import { log } from '../log'
import { C } from './bits'
import { TEST } from './testhooks'
export const NEWS_SEEN_KEY = 'singz.releaseNotesSeen'
export default function WhatsNewScreen({ onClose, previous }: { onClose: () => void; previous?: string }): React.JSX.Element {
  const locale = useLocale(), insets = useSafeAreaInsets()
  const notes = releaseHighlights(RELEASE_VERSION, previous, locale, Platform.OS === 'ios' ? 'ios' : 'android')
  useEffect(() => {
    if (TEST) { TEST.newsClose = onClose; TEST.whatsNewVersion = notes?.version; TEST.whatsNewHighlights = notes?.entries }
  }, [notes?.version, locale])
  useEffect(() => {
    return () => {
      // Swiping or Android Back acknowledges the same version as Got it.
      void getStoredText(NEWS_SEEN_KEY).then(previous => {
        if (releaseHighlights(RELEASE_VERSION, previous ?? undefined, locale, Platform.OS === 'ios' ? 'ios' : 'android'))
          return setStoredText(NEWS_SEEN_KEY, RELEASE_VERSION)
      }).catch(error => log('whats-new', String(error), 'error'))
    }
  }, [])
  const open = (url: string): void => { void Linking.openURL(url).catch(error => log('whats-new', String(error), 'error')) }
  return <View style={[s.root, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]}>
    <View style={s.heading}><Text style={s.brand}>SingZ <Text style={s.version}>v{RELEASE_VERSION}</Text></Text><Pressable accessibilityRole="button" accessibilityLabel={t('phone.app.whatsNew.done')} onPress={onClose} hitSlop={12}><Text style={s.close}>×</Text></Pressable></View>
    <Text style={s.title}>{t('phone.app.whatsNew.title')}</Text>
    <Pressable accessibilityRole="link" onPress={() => open('https://t.me/SingZapp')} style={s.telegram}>
      <Image source={require('../../assets/telegram-logo.png')} style={{ width: 42, height: 42 }} /><View style={{ flex: 1 }}><Text style={s.subtitle}>{t('phone.app.whatsNew.subscribe')}</Text><Text style={s.description}>{t('phone.app.whatsNew.telegramDescription')}</Text></View><Text style={s.close}>↗</Text>
    </Pressable>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 12 }}>
      {notes?.entries.map(entry => <View key={entry.version}>{entry.highlights.map((item, index) => <View key={item.id} style={s.highlight}>
        <View style={s.icon}><Icon name={({news:'progress',export:'skip',mic:'note',controls:'settings'} as const)[item.icon]} size={24} color={C.amber} /></View><View style={{ flex: 1 }}>{item.desktopOnly && !entry.highlights[index - 1]?.desktopOnly && <Text style={s.label}>{t('phone.app.whatsNew.desktop')}</Text>}<Text style={s.subtitle}>{item.title}</Text><Text style={s.description}>{item.description}</Text></View>
      </View>)}</View>)}
    </ScrollView>
    <Pressable accessibilityRole="button" onPress={onClose} style={s.done}><Text style={s.doneText}>{t('phone.app.whatsNew.done')}</Text></Pressable>
    <Pressable accessibilityRole="link" onPress={() => notes && open(notes.url)} style={{ padding: 12, alignItems: 'center' }}><Text style={s.description}>{t('phone.app.whatsNew.fullNotes')} ↗</Text></Pressable>
  </View>
}
const s = StyleSheet.create({
 root:{flex:1,backgroundColor:C.bg,paddingHorizontal:22},heading:{flexDirection:'row',alignItems:'center',justifyContent:'space-between'},brand:{color:C.text,fontSize:17,fontWeight:'800'},version:{color:C.dim,fontSize:13,fontWeight:'500'},close:{color:C.dim,fontSize:26},title:{color:C.text,fontSize:32,fontWeight:'800',marginTop:16,marginBottom:22},telegram:{flexDirection:'row',alignItems:'center',gap:12,padding:16,borderRadius:16,borderWidth:1,borderColor:'#279bd344',backgroundColor:'#279bd30c',marginBottom:12},subtitle:{color:C.text,fontSize:17,fontWeight:'700'},description:{color:C.dim,fontSize:14,lineHeight:21,marginTop:5},highlight:{flexDirection:'row',gap:14,paddingVertical:18,borderBottomWidth:1,borderBottomColor:'#ffffff12'},icon:{width:40,height:42,alignItems:'center',justifyContent:'center',backgroundColor:'#ffa02812',borderRadius:12},label:{color:C.amber,fontSize:12,fontWeight:'700',marginBottom:10},done:{backgroundColor:C.amber,borderRadius:24,padding:14,alignItems:'center',marginTop:12},doneText:{color:'#17130f',fontSize:16,fontWeight:'800'}
})
