import copy, json, tempfile, unittest
from pathlib import Path
from datetime import datetime,timezone
import bet_learning as b

class BetLearningTests(unittest.TestCase):
    def row(self,event='G',at='2026-11-06T20:00:00Z',bet=True):
        x={'type':'spreads','index':1,'side':'away','line':2.5,'label':'POR +2.5','probability':.6,'cost':.5} if bet else None
        return b.make_record(event,'2026-11-07T03:00:00Z','model',x,'verified-run',at)
    def test_actual_handicap_and_total_results_not_winner_accuracy(self):
        self.assertFalse(b.settle(self.row()['bet'],[124,118]))
        self.assertTrue(b.settle({'type':'spreads','index':1,'line':1.5},[3,5]))
        self.assertFalse(b.settle({'type':'spreads','index':1,'line':1.5},[3,1])) # KC +1.5 vs T1 3-1
        self.assertFalse(b.settle({'type':'totals','index':0,'side':'under','line':226.5},[139,132]))
    def test_postgame_records_are_excluded(self):
        self.assertIsNone(self.row(at='2026-11-07T03:00:00Z'))
        self.assertIsNone(self.row(at='2026-11-07T04:00:00Z'))
    def test_latest_no_bet_supersedes_prior_pick_and_duplicates_do_not_count(self):
        first=self.row();last=self.row(at='2026-11-06T22:00:00Z',bet=False)
        r=b.evaluate(b.merge([first,first,last]),{'G':{'scores':[124,118]}})
        self.assertEqual(r['settled_by_model_and_market'],{})
    def test_model_vs_market_is_recorded_for_every_game_and_graded_on_the_same_games(self):
        mk=lambda e,m,k,bet=None:b.make_record(e,'2026-11-07T03:00:00Z','model',bet,'run','2026-11-06T20:00:00Z',benchmark={'model':m,'market':k})
        rows=[mk('A',.70,.60),mk('B',.55,.65),mk('C',.40,.48),mk('T',.5,.5)]
        self.assertEqual(rows[0]['benchmark'],{'model':.7,'market':.6});self.assertIsNone(rows[0]['bet'])
        for bad in (None,{},{'model':.6},{'model':None,'market':.5},{'model':1.0,'market':.5},{'model':.6,'market':0},{'model':'x','market':.5}):
            self.assertNotIn('benchmark',b.make_record('Z','2026-11-07T03:00:00Z','model',None,'run','2026-11-06T20:00:00Z',benchmark=bad))
        plain=b.make_record('Z','2026-11-07T03:00:00Z','model',None,'run','2026-11-06T20:00:00Z')
        self.assertNotIn('benchmark',plain);self.assertEqual(len(b.merge([plain,rows[0],rows[0]])),2)
        # scores are [home, away]; A home win, B away win, C away win, T tie (skipped), unsettled games skipped
        r=b.evaluate(b.merge(rows),{'A':{'scores':[3,1]},'B':{'scores':[1,2]},'C':{'scores':[0,4]},'T':{'scores':[2,2]}})['model_vs_market']
        import math
        self.assertEqual(r['n'],3)
        self.assertAlmostEqual(r['model_log_loss'],-(math.log(.7)+math.log(.45)+math.log(.6))/3)
        self.assertAlmostEqual(r['market_log_loss'],-(math.log(.6)+math.log(.35)+math.log(.52))/3)
        self.assertAlmostEqual(r['log_loss_diff'],r['model_log_loss']-r['market_log_loss'])
        self.assertEqual(r['verdict'],'too few games to say')
        self.assertEqual(r['disagree_over_5pts']['n'],3);self.assertEqual(r['disagree_over_5pts']['model_side_won'],1)   # A: model leans home, home won; B and C: model leans away, away won
        self.assertEqual(b.evaluate([self.row()],{'G':{'scores':[124,118]}})['model_vs_market'],{'n':0})
        big=[mk(str(i),.62,.60) for i in range(250)]
        v=b.evaluate(b.merge(big),{str(i):{'scores':[1,0] if i%5 else [0,1]} for i in range(250)})['model_vs_market']
        self.assertEqual(v['n'],250);self.assertIn(v['verdict'],('model at least matches the market','no measurable difference yet','market is more accurate than the model'))
    def test_nba_capture_stores_model_and_market_for_every_game(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'out').mkdir()
            games=[{'id':'1','tip':'2026-11-17T03:00:00Z','homeWin':.61},{'id':'2','tip':'2026-11-17T03:30:00Z','homeWin':.45},{'id':'3','tip':'2026-11-17T04:00:00Z','homeWin':.5}]
            (root/'out/predictions.json').write_text(json.dumps({'date':'2026-11-16','modelVersion':'m','games':games}))
            bets={'date':'2026-11-16','fetchedAt':'2026-11-16T23:59:00Z','rules':{'selection':'p'},'games':[
                {'gameId':'1','best':None,'marketWin':{'home':.58,'away':.42}},{'gameId':'2','best':None,'marketWin':None},{'gameId':'3','best':None}]}
            (root/'out/bets.json').write_text(json.dumps(bets))
            rows={r['event_id']:r for r in b.capture(root,'nba-oracle','2026-11-17T00:00:00Z','test')}
            self.assertEqual(rows['1']['benchmark'],{'model':.61,'market':.58});self.assertIsNone(rows['1']['bet'])
            self.assertNotIn('benchmark',rows['2']);self.assertNotIn('benchmark',rows['3'])
            stale={r['event_id']:r for r in b.capture(root,'nba-oracle','2026-11-17T00:10:00Z','test')}
            self.assertNotIn('benchmark',stale['1'])   # a quote older than five minutes is not a pre-game price
    def test_modified_archive_rejected(self):
        r=self.row();r['bet']['probability']=.9
        with self.assertRaises(AssertionError):b.merge([r])
    def test_conditional_games_and_pushes_not_false_losses(self):
        self.assertIsNone(b.settle({'type':'game','index':1},[3,0]))
        self.assertIsNone(b.settle({'type':'totals','index':0,'side':'under','line':6},[4,2]))
    def test_reliability_and_profit_are_separate(self):
        r=b.evaluate([self.row()],{'G':{'scores':[124,118]}})
        group=next(iter(r['settled_by_model_and_market'].values()))
        self.assertEqual(group['wins'],0);self.assertEqual(group['flat_cost_roi'],-1)
        self.assertAlmostEqual(group['brier'],.36)
    def test_over_and_under_calibration_are_separate(self):
        def total(event,side):
            return b.make_record(event,'2026-11-07T03:00:00Z','model',
                {'type':'totals','index':0,'side':side,'line':220.5,'label':side+' 220.5','probability':.65,'cost':.6},
                'verified-run','2026-11-06T20:00:00Z')
        rs=[total('G1','over'),total('G2','under')]
        report=b.evaluate(b.merge(rs),{'G1':{'scores':[100,100]},'G2':{'scores':[100,100]}})
        group=next(iter(report['settled_by_model_and_market'].values()))
        self.assertEqual(group['wins'],1)
        self.assertEqual(group['by_direction']['over']['wins'],0)
        self.assertEqual(group['by_direction']['under']['wins'],1)
        self.assertEqual(group['by_direction']['over']['calibration_proposal']['status'],'insufficient_forward_sample')

    def test_selection_policies_not_pooled(self):
        first=self.row(event='G1');later=self.row(event='G2')
        later.pop('key');later['selection_policy']='availability-stress-v2';later['key']=b.digest(later)
        report=b.evaluate(b.merge([first,later]),{'G1':{'scores':[124,118]},'G2':{'scores':[120,124]}})
        self.assertEqual(len(report['settled_by_model_and_market']),2)

if __name__=='__main__':unittest.main()
