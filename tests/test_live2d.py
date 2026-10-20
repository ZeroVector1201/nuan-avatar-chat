import asyncio,base64,json,unittest
from unittest.mock import patch
import httpx
from fastapi.testclient import TestClient
import server
from speech import pcm_chunks
from test_chat import FakeActor

class Bytes(httpx.AsyncByteStream):
    def __init__(self,chunks):self.chunks=chunks
    async def __aiter__(self):
        for chunk in self.chunks:yield chunk

class Live2DTests(unittest.TestCase):
    def until(self,ws,kind):
        events=[]
        for _ in range(40):
            d=ws.receive_json();events.append(d)
            if d['type']==kind:return events
        self.fail('Missing '+kind)
    def test_switch_preserves_context_and_voice_without_natural_worker(self):
        calls=[];tts=[]
        def handle(req):
            body=json.loads(req.content)
            if req.url.path.endswith('/audio/speech'):
                tts.append(body)
                return httpx.Response(200,stream=Bytes([b'\0'*101,b'\0'*100,b'\0'*799]),
                                      headers={'content-type':'audio/pcm'})
            calls.append(body)
            return httpx.Response(200,content='data: {"choices":[{"delta":{"content":"一起聊聊吧。"}}]}\n\ndata: [DONE]\n\n')
        async def forbidden(*args):raise AssertionError('Live2D must not call the natural worker')
        with patch('server.Actor',FakeActor),TestClient(server.app) as client:
            server.app.state.client=httpx.AsyncClient(transport=httpx.MockTransport(handle))
            with client.websocket_connect('/ws',headers={'Origin':'http://testserver'}) as ws:
                ws.receive_json()
                ws.send_json(dict(type='text',turn_id='first',text='今天下雨了'))
                self.until(ws,'done')
                ws.send_json(dict(type='avatar_select',avatar='live2d'));self.until(ws,'avatar_selected')
                with patch.object(FakeActor,'speak',forbidden),patch.object(FakeActor,'ensure',forbidden):
                    ws.send_json(dict(type='text',turn_id='second',text='还记得刚才的天气吗'))
                    events=self.until(ws,'done')
                chunks=[d for d in events if d['type']=='audio_chunk']
                self.assertEqual(sum(len(base64.b64decode(d['data'])) for d in chunks),1000)
                self.assertEqual([d['seq'] for d in chunks],list(range(len(chunks))))
                self.assertEqual(next(d for d in events if d['type']=='audio_end')['samples'],500)
                self.assertFalse(any(d['type'].startswith('actor_') for d in events))
                self.assertEqual(calls[1]['messages'][1]['content'],'今天下雨了')
                self.assertEqual(tts[0]['voice'],'serena');self.assertEqual(tts[0]['speed'],1.0)
                ws.send_json(dict(type='avatar_select',avatar='natural'))
                self.until(ws,'actor_stream_start')
                ws.send_json(dict(type='text',turn_id='third',text='继续'))
                self.until(ws,'done')
                self.assertEqual(len(calls[2]['messages']),6)
            asyncio.run(server.app.state.client.aclose())
    def test_pcm_rejects_truncated_or_non_pcm_streams(self):
        async def run(data,mime):
            async with httpx.AsyncClient(transport=httpx.MockTransport(
                lambda r:httpx.Response(200,content=data,headers={'content-type':mime}))) as client:
                return [x async for x in pcm_chunks(client,'http://tts',{})]
        for data,mime in [(b'123','audio/pcm'),(b'{}','application/json'),(b'','audio/pcm')]:
            with self.assertRaises(ValueError):asyncio.run(run(data,mime))
    def test_invalid_avatar_does_not_change_renderer(self):
        with TestClient(server.app) as client:
            with client.websocket_connect('/ws',headers={'Origin':'http://testserver'}) as ws:
                ws.receive_json();ws.send_json(dict(type='avatar_select',avatar='other'))
                self.assertEqual(ws.receive_json()['type'],'error')
                ws.send_json(dict(type='avatar_select',avatar='live2d'))
                self.assertEqual(ws.receive_json()['avatar'],'live2d')

if __name__=='__main__':unittest.main()
