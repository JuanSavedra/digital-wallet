import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';

describe('UsersService', () => {
  let usersService: UsersService;
  let prisma: { user: Record<string, jest.Mock> };

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    };
    usersService = new UsersService(prisma as unknown as PrismaService);
  });

  it('findByEmail delegates to prisma.user.findUnique by email', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: '1' });

    const result = await usersService.findByEmail('user@example.com');

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'user@example.com' },
    });
    expect(result).toEqual({ id: '1' });
  });

  it('findById delegates to prisma.user.findUnique by id', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: '1' });

    await usersService.findById('1');

    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: '1' } });
  });

  it('create delegates to prisma.user.create with email and password hash', async () => {
    prisma.user.create.mockResolvedValue({ id: '1' });

    await usersService.create('user@example.com', 'hashed');

    expect(prisma.user.create).toHaveBeenCalledWith({
      data: { email: 'user@example.com', passwordHash: 'hashed' },
    });
  });
});
