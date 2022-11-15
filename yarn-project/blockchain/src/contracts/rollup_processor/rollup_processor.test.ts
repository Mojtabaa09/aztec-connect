import { EthAddress } from '@aztec/barretenberg/address';
import { Asset, TxHash } from '@aztec/barretenberg/blockchain';
import { DefiInteractionNote, packInteractionNotes } from '@aztec/barretenberg/note_algorithms';
import { InnerProofData, RollupProofData } from '@aztec/barretenberg/rollup_proof';
import { Block } from '@aztec/barretenberg/block_source';
import { randomBytes } from 'crypto';
import { Signer } from 'ethers';
import { keccak256, Result, toUtf8Bytes } from 'ethers/lib/utils.js';
import { ethers } from 'hardhat';
import {
  evmSnapshot,
  evmRevert,
  advanceBlocksHardhat,
  blocksToAdvanceHardhat,
} from '../../ganache/hardhat_chain_manipulation.js';
import { FeeDistributor } from '../fee_distributor/index.js';
import {
  createAccountProof,
  createDefiClaimProof,
  createDefiDepositProof,
  createDepositProof,
  createRollupProof,
  createSendProof,
  createWithdrawProof,
  DefiInteractionData,
  mergeInnerProofs,
} from './fixtures/create_mock_proof.js';
import { deployMockBridge, MockBridgeParams } from './fixtures/setup_defi_bridges.js';
import { setupTestRollupProcessor } from './fixtures/setup_upgradeable_test_rollup_processor.js';
import { RollupProcessor } from './rollup_processor.js';
import { numToUInt32BE } from '@aztec/barretenberg/serialize';

describe('rollup_processor', () => {
  let feeDistributor: FeeDistributor;
  let rollupProcessor: RollupProcessor;
  let signers: Signer[];
  let addresses: EthAddress[];
  let assets: Asset[];
  let assetAddresses: EthAddress[];

  let snapshot: string;

  const OWNER_ROLE = keccak256(toUtf8Bytes('OWNER_ROLE'));
  const escapeBlockLowerBound = 80;
  const escapeBlockUpperBound = 100;

  const mockBridge = (params: MockBridgeParams = {}) =>
    deployMockBridge(signers[0], rollupProcessor, assetAddresses, params);

  // Extracts the 'args' of each event emitted by the tx.
  const fetchResults = async (txHash: TxHash, eventName: string): Promise<Result> => {
    const receipt = await ethers.provider.getTransactionReceipt(txHash.toString());
    const eventArgs = receipt.logs
      .filter(l => l.address === rollupProcessor.address.toString())
      .map(l => rollupProcessor.contract.interface.parseLog(l))
      .filter(e => e.eventFragment.name === eventName)
      .map(e => e.args);
    return eventArgs;
  };

  const decodeRollup = (block: Block) => {
    const rollup = RollupProofData.decode(block.encodedRollupProofData);
    // Coax lazy init of txId
    rollup.innerProofData.forEach(x => x.txId);
    return rollup;
  };

  beforeAll(async () => {
    signers = await ethers.getSigners();
    addresses = await Promise.all(signers.map(async u => EthAddress.fromString(await u.getAddress())));
    ({ rollupProcessor, feeDistributor, assets, assetAddresses } = await setupTestRollupProcessor(signers, {
      numberOfTokenAssets: 1,
      escapeBlockLowerBound,
      escapeBlockUpperBound,
    }));
    // Advance into block region where escapeHatch is active.
    const blocks = await blocksToAdvanceHardhat(escapeBlockLowerBound, escapeBlockUpperBound, ethers.provider);
    await advanceBlocksHardhat(blocks, ethers.provider);
  });

  beforeEach(async () => {
    snapshot = await evmSnapshot();
  });

  afterEach(async () => {
    await evmRevert(snapshot);
  });

  it('read escape block bounds', async () => {
    expect(await rollupProcessor.escapeBlockLowerBound()).toBe(80n);
    expect(await rollupProcessor.escapeBlockUpperBound()).toBe(100n);
  });

  it('read rollup providers', async () => {
    expect(await rollupProcessor.rollupProviders(EthAddress.ZERO)).toBeFalsy;
    expect(await rollupProcessor.rollupProviders(addresses[0])).toBeTruthy;
  });

  it('read paused', async () => {
    expect(await rollupProcessor.paused()).toBeFalsy;
  });

  it('read third party contract status', async () => {
    expect(await rollupProcessor.getThirdPartyContractStatus()).toBeFalsy;
  });

  it('read verifier', async () => {
    expect(await rollupProcessor.verifier()).not.toEqual(EthAddress.ZERO);
  });

  it('read defi bridge proxy', async () => {
    expect(await rollupProcessor.defiBridgeProxy()).not.toEqual(EthAddress.ZERO);
  });

  it('read data size', async () => {
    expect(await rollupProcessor.dataSize()).toBe(0);
  });

  it('read pending defi interaction hashes length', async () => {
    expect(await rollupProcessor.getPendingDefiInteractionHashesLength()).toBe(0);
  });

  it('read defi interaction hashes length', async () => {
    expect(await rollupProcessor.getDefiInteractionHashesLength()).toBe(0);
  });

  it('read defiInteractionHashes', async () => {
    expect(await rollupProcessor.defiInteractionHashes()).toEqual([]);
  });

  it('read async defi interaction hashes length', async () => {
    expect(await rollupProcessor.getAsyncDefiInteractionHashesLength()).toBe(0);
  });

  it('read async defi interaction hashes', async () => {
    expect(await rollupProcessor.asyncDefiInteractionHashes()).toEqual([]);
  });

  it('read prev defi interaction hash', async () => {
    const prevDefiHash = Buffer.from('14e0f351ade4ba10438e9b15f66ab2e6389eea5ae870d6e8b2df1418b2e6fd5b', 'hex');
    expect(await rollupProcessor.prevDefiInteractionsHash()).toEqual(prevDefiHash);
  });

  it('read state hash', async () => {
    const expectedStateHash = Buffer.from(
      keccak256(
        Buffer.concat([
          numToUInt32BE(0, 32),
          Buffer.from('18ceb5cd201e1cee669a5c3ad96d3c4e933a365b37046fc3178264bede32c68d', 'hex'),
          Buffer.from('298329c7d0936453f354e4a5eef4897296cc0bf5a66f2a528318508d2088dafa', 'hex'),
          Buffer.from('2fd2364bfe47ccb410eba3a958be9f39a8c6aca07db1abd15f5a211f51505071', 'hex'),
          Buffer.from('2e4ab7889ab3139204945f9e722c7a8fdb84e66439d787bd066c3d896dba04ea', 'hex'),
        ]),
      ).slice(2),
      'hex',
    );
    expect(await rollupProcessor.stateHash()).toEqual(expectedStateHash);
  });

  it('read supported bridges length', async () => {
    expect(await rollupProcessor.getSupportedBridgesLength()).toBe(1);
  });

  it('read supported bridge gas limit', async () => {
    expect(await rollupProcessor.getBridgeGasLimit(1)).toBe(300000);
  });

  it('read supported asset address', async () => {
    const dai = assets[1];
    expect(await rollupProcessor.getSupportedAsset(1)).toEqual(dai.getStaticInfo().address);
  });

  it('read supported assets length', async () => {
    expect(await rollupProcessor.getSupportedAssetsLength()).toBe(1);
  });

  it('read supported asset gas limit', async () => {
    const dai = assets[1];
    expect(await rollupProcessor.getAssetGasLimit(1)).toBe(dai.getStaticInfo().gasLimit);
  });

  it('read supported assets', async () => {
    expect(await rollupProcessor.getSupportedAssets()).toEqual(
      assets
        .slice(1)
        .map(a => a.getStaticInfo())
        .map(({ address, gasLimit }) => ({ address, gasLimit })),
    );
  });

  it('read escape hatch status', async () => {
    const escapeHatchStatus = await rollupProcessor.getEscapeHatchStatus();
    expect(typeof escapeHatchStatus.escapeOpen).toBe('boolean');
    expect(typeof escapeHatchStatus.blocksRemaining).toBe('number');
  });

  it('should get contract status', async () => {
    expect(rollupProcessor.address).toEqual(rollupProcessor.address);
    expect(await rollupProcessor.dataSize()).toBe(0);
    expect(await rollupProcessor.getSupportedAssets()).toEqual(
      assets
        .slice(1)
        .map(a => a.getStaticInfo())
        .map(({ address, gasLimit }) => ({ address, gasLimit })),
    );
    expect(await rollupProcessor.getEscapeHatchStatus()).toEqual({ escapeOpen: true, blocksRemaining: 20 });
  });

  it('owner should be able to set the allowThirdParty contract flag', async () => {
    const statusBefore = await rollupProcessor.getThirdPartyContractStatus();
    expect(statusBefore).toBe(false);

    await expect(
      rollupProcessor.setThirdPartyContractStatus(true, {
        signingAddress: EthAddress.fromString(await signers[1].getAddress()),
      }),
    ).rejects.toThrow(`AccessControl: account ${addresses[1].toString().toLowerCase()} is missing role ${OWNER_ROLE}`);

    await rollupProcessor.setThirdPartyContractStatus(true, {
      signingAddress: EthAddress.fromString(await signers[0].getAddress()),
    });

    const statusAfter = await rollupProcessor.getThirdPartyContractStatus();
    expect(statusAfter).toBe(true);
  });

  it('should get supported asset', async () => {
    const supportedAssetAAddress = await rollupProcessor.getSupportedAsset(1);
    expect(supportedAssetAAddress).toEqual(assets[1].getStaticInfo().address);
  });

  it('should throw for a virtual asset', async () => {
    const assetIdA = 1 << 29;
    await expect(rollupProcessor.getSupportedAsset(assetIdA)).rejects.toThrow(); //'INVALID_ASSET_ID');
    const assetIdB = 0x2abbccdd;
    await expect(rollupProcessor.getSupportedAsset(assetIdB)).rejects.toThrow(); //'INVALID_ASSET_ID');
  });

  it('should approve a proof', async () => {
    const proofHash = randomBytes(32);
    expect(await rollupProcessor.getProofApprovalStatus(addresses[0], proofHash)).toBe(false);
    expect(await rollupProcessor.getProofApprovalStatus(addresses[1], proofHash)).toBe(false);
    await rollupProcessor.approveProof(proofHash, { signingAddress: addresses[1] });
    expect(await rollupProcessor.getProofApprovalStatus(addresses[0], proofHash)).toBe(false);
    expect(await rollupProcessor.getProofApprovalStatus(addresses[1], proofHash)).toBe(true);
  });

  it('should allow any address to use escape hatch', async () => {
    const { encodedProofData } = createRollupProof(signers[0], createSendProof());
    const tx = await rollupProcessor.createRollupProofTx(encodedProofData, [], []);
    await rollupProcessor.sendTx(tx, { signingAddress: EthAddress.fromString(await signers[1].getAddress()) });
  });

  it('should reject a rollup from an unknown provider outside escape hatch window', async () => {
    const { encodedProofData, signatures } = createRollupProof(signers[0], createSendProof(), {
      feeDistributorAddress: feeDistributor.address,
    });
    await advanceBlocksHardhat(50, ethers.provider);

    const { escapeOpen } = await rollupProcessor.getEscapeHatchStatus();
    expect(escapeOpen).toBe(false);
    const tx = await rollupProcessor.createRollupProofTx(encodedProofData, signatures, []);

    await expect(
      rollupProcessor.sendTx(tx, { signingAddress: EthAddress.fromString(await signers[1].getAddress()) }),
    ).rejects.toThrow(); //'INVALID_PROVIDER');
  });

  it('should allow the owner to change the verifier address', async () => {
    const txHash = await rollupProcessor.setVerifier(rollupProcessor.address);
    const [{ verifierAddress }] = await fetchResults(txHash, 'VerifierUpdated');

    expect(verifierAddress.toString()).toBe(rollupProcessor.address.toString());
  });

  it('should not be able to set the verifier if not the owner', async () => {
    await expect(
      rollupProcessor.setVerifier(rollupProcessor.address, { signingAddress: addresses[1] }),
    ).rejects.toThrow(`AccessControl: account ${addresses[1].toString().toLowerCase()} is missing role ${OWNER_ROLE}`);
  });

  it('should get escape hatch open status', async () => {
    const nextEscapeBlock = await blocksToAdvanceHardhat(80, 100, ethers.provider);
    await advanceBlocksHardhat(nextEscapeBlock, ethers.provider);

    const { escapeOpen, blocksRemaining } = await rollupProcessor.getEscapeHatchStatus();
    expect(escapeOpen).toBe(true);
    expect(blocksRemaining).toBe(20);
  });

  it('should get escape hatch closed status', async () => {
    const nextEscapeBlock = await blocksToAdvanceHardhat(79, 100, ethers.provider);
    await advanceBlocksHardhat(nextEscapeBlock, ethers.provider);

    const { escapeOpen, blocksRemaining } = await rollupProcessor.getEscapeHatchStatus();
    expect(escapeOpen).toBe(false);
    expect(blocksRemaining).toBe(1);
  });

  it('should process all proof types and get specified blocks', async () => {
    const inputAssetId = 1;
    const outputValueA = 7n;
    const bridgeCallData = await mockBridge({
      inputAssetIdA: inputAssetId,
      outputAssetIdA: 0,
      outputValueA,
    });
    const numberOfBridgeCalls = RollupProofData.NUM_BRIDGE_CALLS_PER_BLOCK;

    const userAAddress = addresses[1];
    const userA = signers[1];

    const depositAmount = 30n;
    const sendAmount = 6n;
    const defiDepositAmount0 = 12n;
    const defiDepositAmount1 = 8n;
    const withdrawalAmount = 10n;

    const innerProofOutputs = [
      await createDepositProof(depositAmount, userAAddress, userA, inputAssetId),
      mergeInnerProofs([createAccountProof(), createSendProof(inputAssetId, sendAmount)]),
      mergeInnerProofs([
        createDefiDepositProof(bridgeCallData, defiDepositAmount0),
        createDefiDepositProof(bridgeCallData, defiDepositAmount1),
      ]),
      createWithdrawProof(withdrawalAmount, userAAddress, inputAssetId),
      createDefiClaimProof(bridgeCallData),
    ];

    const expectedInteractionResult = [
      new DefiInteractionNote(bridgeCallData, numberOfBridgeCalls * 2, 12n, outputValueA, 0n, true),
      new DefiInteractionNote(bridgeCallData, numberOfBridgeCalls * 2 + 1, 8n, outputValueA, 0n, true),
    ];
    const previousDefiInteractionHash = packInteractionNotes(expectedInteractionResult, numberOfBridgeCalls);

    // Deposit to contract.
    await assets[inputAssetId].approve(depositAmount, userAAddress, rollupProcessor.address);
    await rollupProcessor.depositPendingFunds(inputAssetId, depositAmount, undefined, {
      signingAddress: userAAddress,
    });

    for (let i = 0; i < innerProofOutputs.length; ++i) {
      const { encodedProofData, signatures, offchainTxData } = createRollupProof(signers[0], innerProofOutputs[i], {
        rollupId: i,
        defiInteractionData:
          i === 2
            ? [
                new DefiInteractionData(bridgeCallData, defiDepositAmount0),
                new DefiInteractionData(bridgeCallData, defiDepositAmount1),
              ]
            : [],
        previousDefiInteractionHash: i === 3 ? previousDefiInteractionHash : undefined,
      });
      // Use a small chunk size to test offchain chunking.
      const txs = await rollupProcessor.createRollupTxs(encodedProofData, signatures, offchainTxData, 300);
      await rollupProcessor.sendRollupTxs(txs);
    }

    const blocks = await rollupProcessor.getRollupBlocksFrom(0, 1);
    expect(blocks.length).toBe(5);

    {
      const block = blocks[0];
      const rollup = decodeRollup(block);
      const { innerProofs, offchainTxData } = innerProofOutputs[0];
      expect(block).toMatchObject({
        rollupId: 0,
        rollupSize: 2,
        interactionResult: [],
        offchainTxData,
      });
      expect(rollup).toMatchObject({
        rollupId: 0,
        dataStartIndex: 0,
        innerProofData: [innerProofs[0], InnerProofData.PADDING],
      });
    }

    const numRealTxsInRollup = 4;

    {
      const block = blocks[1];
      const rollup = decodeRollup(block);
      const { innerProofs, offchainTxData } = innerProofOutputs[1];
      expect(block).toMatchObject({
        rollupId: 1,
        rollupSize: 2,
        interactionResult: [],
        offchainTxData,
      });
      expect(rollup).toMatchObject({
        rollupId: 1,
        dataStartIndex: 1 * numRealTxsInRollup,
        innerProofData: innerProofs,
      });
    }

    {
      const block = blocks[2];
      const rollup = decodeRollup(block);
      const { innerProofs, offchainTxData } = innerProofOutputs[2];
      expect(block).toMatchObject({
        rollupId: 2,
        rollupSize: 2,
        offchainTxData,
        interactionResult: expectedInteractionResult,
      });
      expect(rollup).toMatchObject({
        rollupId: 2,
        dataStartIndex: 2 * numRealTxsInRollup,
        innerProofData: innerProofs,
      });
    }

    {
      const block = blocks[3];
      const rollup = decodeRollup(block);
      const { innerProofs, offchainTxData } = innerProofOutputs[3];
      expect(block).toMatchObject({
        rollupId: 3,
        rollupSize: 2,
        offchainTxData,
        interactionResult: [],
      });
      expect(rollup).toMatchObject({
        rollupId: 3,
        dataStartIndex: 3 * numRealTxsInRollup,
        innerProofData: [innerProofs[0], InnerProofData.PADDING],
      });
    }

    {
      const block = blocks[4];
      const rollup = decodeRollup(block);
      const { innerProofs, offchainTxData } = innerProofOutputs[4];
      expect(block).toMatchObject({
        rollupId: 4,
        rollupSize: 2,
        offchainTxData,
        interactionResult: [],
      });
      expect(rollup).toMatchObject({
        rollupId: 4,
        dataStartIndex: 4 * numRealTxsInRollup,
        innerProofData: [innerProofs[0], InnerProofData.PADDING],
      });
    }
  });

  it('check getters', async () => {
    expect((await rollupProcessor.getSupportedAssets()).length).toBe(await rollupProcessor.getSupportedAssetsLength());

    expect((await rollupProcessor.getSupportedBridges()).length).toBe(
      await rollupProcessor.getSupportedBridgesLength(),
    );

    expect((await rollupProcessor.defiInteractionHashes()).length).toBe(
      await rollupProcessor.getDefiInteractionHashesLength(),
    );

    expect((await rollupProcessor.asyncDefiInteractionHashes()).length).toBe(
      await rollupProcessor.getAsyncDefiInteractionHashesLength(),
    );

    expect(await rollupProcessor.getPendingDefiInteractionHashesLength()).toBe(
      (await rollupProcessor.getAsyncDefiInteractionHashesLength()) +
        (await rollupProcessor.getDefiInteractionHashesLength()),
    );
  });
});