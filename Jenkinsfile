pipeline {
    agent any

    environment {
        IMAGE_NAME = "color-hunter_api"
        CONTAINER_NAME = "color-hunter-api"
        APP_PORT = "4000" 
    }

    stages {
        stage('Database') {
            steps {
                echo 'Démarrage de la base de données...'
                sh 'docker compose up -d db'
                sh 'docker compose run --rm db sh -c "until mysqladmin ping -h color-hunter_db --silent; do sleep 2; done"'
            }
        }

        stage('Docker Build') {
            steps {
                echo 'Construction de l\'image Docker...'
                sh 'docker build -t ${IMAGE_NAME}:latest .'
            }
        }
        stage('Deploy') {
            steps {
                echo 'Déploiement du conteneur...'
                script {
                    // 1. Arrêter et supprimer l'ancien conteneur s'il existe
                    sh "docker stop ${CONTAINER_NAME} || true"
                    sh "docker rm ${CONTAINER_NAME} || true"
                    
                    // 2. Lancer le nouveau conteneur
                    // On passe le fichier .env présent sur le VPS
                    sh """
                        docker run -d \
                        --name ${CONTAINER_NAME} \
                        --network color-hunter-network \
                        -p ${APP_PORT}:${APP_PORT} \
                        --restart unless-stopped \
                        ${IMAGE_NAME}:latest
                    """
                }
            }
        }

        stage('Cleanup') {
            steps {
                echo 'Nettoyage des images inutilisées...'
                sh 'docker image prune -f'
            }
        }
    }

    post {
        success {
            echo '✅ Déploiement réussi !'
        }
        failure {
            echo '❌ Le déploiement a échoué. Vérifie les logs.'
        }
    }
}
