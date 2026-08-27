/**
 * Stub mínimo del Worker de datos.
 * Las peticiones a archivos existentes las sirve Static Assets sin invocar este script
 * (run_worker_first: false). Solo se usa si hace falta un Worker script para el deploy.
 */
export default {
  async fetch(): Promise<Response> {
    return new Response('litromio-data: use /manifest.json', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
