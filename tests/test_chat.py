import asyncio,base64,io,json,unittest,wave
from unittest.mock import patch
import httpx
from fastapi.testclient import TestClient
import server
from chat import messages,speech_request

class FakeActor:
    def __init__(self,url,portrait,send):self.send=send
    async def ensure(self):await self.send('actor_stream_start',stream_id='s',mime='video/mp4')
    async def speak(self,client,tts,turn,text,body):
        await self.send('actor_speech_start',stream_id='s',turn_id=turn,text=text)
        await self.send('actor_cue_start',stream_id='s',turn_id=turn,pts=1)
        await self.send('actor_cue_end',stream_id='s',turn_id=turn,pts=2)
    async def cancel(self,turn=None):pass
    async def close(self):pass

class ChatTests(unittest.TestCase):
    def setUp(self):
        self.requests=[]
        def handle(req):
            if req.url.path.endswith('/transcribe'):return httpx.Response(200,json={'text':'合成语音测试'})
            data=json.loads(req.content);self.requests.append(data)
            chunks=['你好，','很高兴见到你。']
            s=''.join('data: '+json.dumps({'choices':[{'delta':{'content':t}}]},ensure_ascii=False)+'\n\n' for t in chunks)+'data: [DONE]\n\n'
            return httpx.Response(200,content=s.encode(),headers={'Content-Type':'text/event-stream'})
        self.http=httpx.AsyncClient(transport=httpx.MockTransport(handle))
    def tearDown(self):asyncio.run(self.http.aclose())
    def until(self,ws,kind):
        events=[]
        for _ in range(30):
            data=ws.receive_json();events.append(data)
            if data['type']==kind:return events
        self.fail('expected '+kind)
    def test_root_is_direct_chat_and_no_business_endpoints_exist(self):
        with TestClient(server.app) as client:
            r=client.get('/');self.assertEqual(r.status_code,200);self.assertIn('今天，想聊些什么',r.text)
            for path in ['/login','/admin','/student','/api/mobile/assignments','/api/assessment/catalog','/api/platform/me']:
                self.assertEqual(client.get(path).status_code,404)
    def test_one_llm_call_per_turn_uses_chat_history_and_reset_clears_it(self):
        with patch('server.Actor',FakeActor),TestClient(server.app) as client:
            server.app.state.client=self.http
            with client.websocket_connect('/ws',headers={'Origin':'http://testserver'}) as ws:
                self.assertEqual(ws.receive_json()['type'],'hello')
                for i,text in enumerate(['你好','记得我刚才说什么吗？']):
                    ws.send_json(dict(type='text',turn_id=f't{i}',text=text))
                    events=self.until(ws,'done')
                    self.assertIn('actor_cue_end',[x['type'] for x in events])
                self.assertEqual(len(self.requests),2)
                self.assertEqual([m['role'] for m in self.requests[1]['messages']],['system','user','assistant','user'])
                ws.send_json({'type':'reset'});self.until(ws,'cancelled')
                ws.send_json(dict(type='text',turn_id='t3',text='新开始'))
                self.until(ws,'done');self.assertEqual(len(self.requests[2]['messages']),2)
    def test_audio_goes_through_asr_then_same_free_chat(self):
        out=io.BytesIO()
        with wave.open(out,'wb') as f:f.setnchannels(1);f.setsampwidth(2);f.setframerate(16000);f.writeframes(b'\0'*6400)
        with patch('server.Actor',FakeActor),TestClient(server.app) as client:
            server.app.state.client=self.http
            with client.websocket_connect('/ws',headers={'Origin':'http://testserver'}) as ws:
                ws.receive_json();ws.send_json(dict(type='audio',turn_id='voice',audio=base64.b64encode(out.getvalue()).decode()))
                events=self.until(ws,'done');self.assertEqual(next(x for x in events if x['type']=='transcript')['text'],'合成语音测试')
                self.assertEqual(self.requests[0]['messages'][-1]['content'],'合成语音测试')
    def test_invalid_audio_and_cross_origin_are_not_processed(self):
        with TestClient(server.app) as client:
            with self.assertRaises(Exception):
                with client.websocket_connect('/ws',headers={'Origin':'https://other.example'}):pass
            with client.websocket_connect('/ws',headers={'Origin':'http://testserver'}) as ws:
                ws.receive_json();ws.send_json(dict(type='audio',turn_id='v',audio='invalid!!'))
                self.assertEqual(ws.receive_json()['type'],'error')
                ws.send_json({'type':'ping'});self.assertEqual(ws.receive_json()['type'],'pong')
        self.assertEqual(self.requests,[])
    def test_cancel_interrupts_generation_and_keeps_connection_usable(self):
        async def slow(client,url,model,history,text,emit):
            await emit('正在生成');await asyncio.sleep(100);return 'late'
        with patch('server.Actor',FakeActor),patch('server.reply',slow),TestClient(server.app) as client:
            with client.websocket_connect('/ws',headers={'Origin':'http://testserver'}) as ws:
                ws.receive_json();ws.send_json(dict(type='text',turn_id='t',text='hello'))
                self.until(ws,'text');ws.send_json(dict(type='cancel'))
                self.until(ws,'cancelled');ws.send_json({'type':'ping'})
                self.assertEqual(ws.receive_json()['type'],'pong')
    def test_voice_is_constant_and_context_is_bounded(self):
        a,b=speech_request('早上好'),speech_request('今天下雨了')
        for k in ['voice','speed','seed','instructions']:self.assertEqual(a[k],b[k])
        h=[dict(role='user' if i%2==0 else 'assistant',content=str(i)) for i in range(100)]
        self.assertEqual(len(messages(h,'now')),18)

if __name__=='__main__':unittest.main()
