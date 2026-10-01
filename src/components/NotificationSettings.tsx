import { useEffect, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useApp } from '../AppContext';
import { getNotificationStatus } from '../api';
import { disableIncomingNotifications, enableIncomingNotifications, notificationPreference } from '../notifications';
import { Section } from './Section';
import { Txt } from './Txt';
import { space } from '../theme';

export function NotificationSettings() {
  const { userPhone } = useApp();
  const [enabled,setEnabled] = useState(false), [busy,setBusy] = useState(false), [message,setMessage] = useState('');
  const [status,setStatus] = useState<Awaited<ReturnType<typeof getNotificationStatus>> | null>(null);
  useEffect(() => { let cancelled=false;setEnabled(false);setStatus(null);setMessage('');
    if(userPhone) void notificationPreference(userPhone).then(value=>{if(!cancelled)setEnabled(value);}).catch(()=>{});
    return()=>{cancelled=true;};
  },[userPhone]);
  async function toggle() {
    if(!userPhone||busy)return;setBusy(true);setMessage('');
    try { if(enabled)await disableIncomingNotifications(userPhone);else await enableIncomingNotifications(userPhone);setEnabled(!enabled); }
    catch(err){setMessage(err instanceof Error&&!(err.message.includes('HTTP')||err.message.includes('ExponentPushToken'))?err.message:'Unable to update notifications. Use an installed development or release build and try again.');}
    finally{setBusy(false);}
  }
  async function refresh() {
    if(busy)return;setBusy(true);setMessage('');
    try{setStatus(await getNotificationStatus());}catch{setMessage('Unable to check notification status. Please try again.');}
    finally{setBusy(false);}
  }
  return <Section title="Incoming-call notifications">
    <Txt tone="muted">Receive a private alert when someone calls your Dimts number. Open it to see the caller briefing. Delivery depends on your phone, network and notification settings.</Txt>
    {Platform.OS==='web'?<Txt tone="muted">Enable this in the installed iPhone or Android app.</Txt>:<Pressable accessibilityRole="button" disabled={busy} onPress={toggle} style={{minHeight:44,justifyContent:'center'}}>
      <Txt tone="accent">{busy?'Updating…':enabled?'Disable on this phone':'Enable on this phone'}</Txt>
    </Pressable>}
    <Pressable accessibilityRole="button" disabled={busy} onPress={refresh} style={{minHeight:44,justifyContent:'center'}}><Txt tone="accent">Check delivery status</Txt></Pressable>
    {message?<Txt accessibilityRole="alert" tone="muted">{message}</Txt>:null}
    {status&&<View style={{gap:space.sm}}>
      <Txt size="caption" tone="muted">{status.devices.filter(device=>!device.disabled).length} registered device(s). Provider handoff does not prove that a phone displayed the alert.</Txt>
      {status.notifications.map((item,index)=><Txt key={`${item.call_id}-${index}`} size="caption" tone="muted">{item.status==='provider_handoff'?'Handed to the phone notification provider':item.status==='accepted'?'Accepted by Expo; awaiting provider receipt':item.status==='unknown'?'Delivery request unconfirmed':item.status==='failed'?'Notification failed': 'Notification queued'}</Txt>)}
    </View>}
  </Section>;
}
