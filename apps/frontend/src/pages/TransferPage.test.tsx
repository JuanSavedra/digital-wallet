import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as transactionsApi from '../api/transactions';
import * as walletsApi from '../api/wallets';
import { TransferPage } from './TransferPage';

vi.mock('../api/transactions');
vi.mock('../api/wallets');

function renderTransferPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/transfer']}>
        <Routes>
          <Route path="/transfer" element={<TransferPage />} />
          <Route
            path="/transactions/:id"
            element={<div>tela da transação</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TransferPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(walletsApi.lookupWalletByEmail).mockResolvedValue('wallet-b');
  });

  it('shows a validation error and never calls the API for an invalid amount', async () => {
    const user = userEvent.setup();
    renderTransferPage();

    await user.type(
      screen.getByLabelText(/e-mail do destinatário/i),
      'dest@example.com',
    );
    await user.type(screen.getByLabelText(/valor/i), '0');
    await user.click(screen.getByRole('button', { name: /transferir/i }));

    expect(
      await screen.findByText(/valor válido, maior que zero/i),
    ).toBeInTheDocument();
    expect(walletsApi.lookupWalletByEmail).not.toHaveBeenCalled();
    expect(transactionsApi.transfer).not.toHaveBeenCalled();
  });

  it('resolves the recipient by email, submits the amount in cents, and shows the same idempotency key used', async () => {
    const user = userEvent.setup();
    vi.mocked(transactionsApi.transfer).mockResolvedValue({
      id: 'tx-1',
      originWalletId: 'wallet-a',
      destinationWalletId: 'wallet-b',
      amount: '1050',
      status: 'COMPLETED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    renderTransferPage();

    const keyBefore = screen.getByText(/idempotency-key desta tentativa/i)
      .querySelector('code')!.textContent;

    await user.type(
      screen.getByLabelText(/e-mail do destinatário/i),
      'dest@example.com',
    );
    await user.type(screen.getByLabelText(/valor/i), '10,50');
    await user.click(screen.getByRole('button', { name: /transferir/i }));

    await waitFor(() => {
      expect(walletsApi.lookupWalletByEmail).toHaveBeenCalledWith(
        'dest@example.com',
      );
      expect(transactionsApi.transfer).toHaveBeenCalledWith(
        'wallet-b',
        1050,
        keyBefore,
      );
    });

    expect(await screen.findByText('tela da transação')).toBeInTheDocument();
  });

  it('disables the submit button while the request is pending, preventing a double submit', async () => {
    const user = userEvent.setup();
    let resolveTransfer!: (value: Awaited<ReturnType<typeof transactionsApi.transfer>>) => void;
    vi.mocked(transactionsApi.transfer).mockReturnValue(
      new Promise((resolve) => {
        resolveTransfer = resolve;
      }),
    );
    renderTransferPage();

    await user.type(
      screen.getByLabelText(/e-mail do destinatário/i),
      'dest@example.com',
    );
    await user.type(screen.getByLabelText(/valor/i), '5,00');
    const button = screen.getByRole('button', { name: /transferir/i });
    await user.click(button);

    expect(button).toBeDisabled();

    resolveTransfer({
      id: 'tx-1',
      originWalletId: 'wallet-a',
      destinationWalletId: 'wallet-b',
      amount: '500',
      status: 'COMPLETED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await screen.findByText('tela da transação');
    expect(transactionsApi.transfer).toHaveBeenCalledTimes(1);
  });

  it('keeps the same idempotency key when the transfer fails with a network error (no response)', async () => {
    const user = userEvent.setup();
    vi.mocked(transactionsApi.transfer).mockRejectedValue(
      new Error('Network Error'),
    );
    renderTransferPage();

    const keyBefore = screen.getByText(/idempotency-key desta tentativa/i)
      .querySelector('code')!.textContent;

    await user.type(
      screen.getByLabelText(/e-mail do destinatário/i),
      'dest@example.com',
    );
    await user.type(screen.getByLabelText(/valor/i), '5,00');
    await user.click(screen.getByRole('button', { name: /transferir/i }));

    await waitFor(() => {
      expect(transactionsApi.transfer).toHaveBeenCalledTimes(1);
    });

    const keyAfter = screen.getByText(/idempotency-key desta tentativa/i)
      .querySelector('code')!.textContent;
    expect(keyAfter).toBe(keyBefore);
  });
});
