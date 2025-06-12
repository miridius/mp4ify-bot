// separate file to just start the bot on load, all logic is separate for tests

import { start } from './bot';
import { botToken } from './consts';

start(botToken);
