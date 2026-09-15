/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import {
  NOW_PLAYING_KEEP_ALIVE_TASK,
  nowPlayingKeepAlive,
} from './src/playback/now-playing';

AppRegistry.registerComponent(appName, () => App);
// Android: keeps JS timers running while a song plays behind the lock screen
// (see NowPlayingModule). A no-op registration on iOS.
AppRegistry.registerHeadlessTask(NOW_PLAYING_KEEP_ALIVE_TASK, () => nowPlayingKeepAlive);
