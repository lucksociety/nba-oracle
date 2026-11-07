import assert from 'node:assert/strict';
import {scoreSupports,ruleFails} from '../js/markets-jupiter.js';
const g={final:{away:102,home:104}};
for(const [type,side,line,yes] of [['moneyline','home',null,true],['moneyline','away',null,false],['totals','over',206.5,false],['totals','under',206.5,true],['totals','over',206,false],['spreads','away',2.5,true],['spreads','home',-2.5,false],['spreads','home',-2,false]])assert.equal(scoreSupports({type,side,line},g),yes);
assert.equal(scoreSupports({type:'moneyline',side:'home'},{}),false);
assert(ruleFails({scoreConsistent:false,sampleN:300000,type:'moneyline',cost:.55,edge:.04},.6).some(x=>x.includes('predicted score')));
console.log('NBA displayed-score winners, spreads, totals and pushes passed');
