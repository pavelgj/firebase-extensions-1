import * as admin from 'firebase-admin';
import {logger} from 'firebase-functions/v1';
import {FieldValue} from 'firebase-admin/firestore';

import config from '../config';
import {launchJob} from '../dataflow/trigger_dataflow_job';
import {waitForImportCompletion, createImport} from '../utils/import_export';

export const onBackupRestoreHandler = async () => {
  // Set db and storage
  const db = admin.firestore();
  const importDoc = await db
    .doc(config.backupDoc)
    .collection('imports')
    .add({});

  // Get the latest backup collection
  const backupExportsCollection = db
    .doc(config.backupDoc)
    .collection('exports');

  const completedExports = await backupExportsCollection
    .where('status', '==', 'Completed')
    .get();

  const documents = completedExports.docs.map(doc => ({
    id: doc.id,
    data: doc.data(),
  }));

  // Sort documents by timestamp in descending order
  const sortedDocuments = documents.sort(
    (a, b) => b.data.timestamp.toDate() - a.data.timestamp.toDate()
  );

  // Get the most recent document
  const doc = sortedDocuments.length > 0 ? sortedDocuments[0] : null;

  //TODO: use this version in the future, index creation is needed.
  // const backupDocuments = await db
  //   .doc(config.backupDoc)
  //   .collection('exports')
  //   .where('status', '==', 'Completed')
  //   .orderBy('timestamp', 'desc')
  //   .limit(1)
  //   .get();

  // Get the latest backup
  const backupId = doc?.id;

  // If no backup
  if (!backupId) {
    logger.info('No backup found');
    return Promise.resolve();
  }

  try {
    // Export the Firestore db to storage
    const {id, operation} = await createImport(backupId);

    // Update Firestore for tracking
    await importDoc.set({
      id,
      status: 'Running import...',
      operation: operation.name,
      timestamp: FieldValue.serverTimestamp(),
    });

    // Wait for import completion
    await waitForImportCompletion(operation.name || '');

    await importDoc.set({
      id,
      status: 'Initial backup restored, replaying final updates...',
      operation: operation.name,
      timestamp: FieldValue.serverTimestamp(),
    });

    // Run DataFLow updates
    await launchJob();

    await importDoc.set({
      id,
      status: 'Completed',
      operation: operation.name,
      timestamp: FieldValue.serverTimestamp(),
    });
  } catch (ex: any) {
    logger.error('Error restoring backup', ex);

    await db.doc(config.backupDoc).collection('exports').add({
      error: ex.message,
      status: 'Failed',
      timestamp: FieldValue.serverTimestamp(),
    });

    return Promise.resolve();
  }
};