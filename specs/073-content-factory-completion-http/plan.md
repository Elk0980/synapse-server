# План

Root owns server.js, новый content-factory-completion-http.js/test и integrationHTTPtest/spec073. CF20 owns autoposting.js/variants-historytest; CF22 owns service/worker/media-mentorHTTP/test/spec072. Root не правит их до сдачи. Workflow storage CF21 принят6SHA/own8/8.

Handler перехватывает только два новых точных маршрута перед общим autoposting handler; существующий proxy prefix уже допускает их с прежними auth/CSRF. Server wiring передаёт optional workflow adapter. Пробы HTTP только после сдачи зависимостей; синтетический временный процесс на loopback без внешнего sender/provider.
