// 每个测试 worker 进程在加载模块前设置测试库连接
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'mysql://root:@localhost:3306/nichongsha_test';